import { homedir } from 'os'
import { loadConfig, toQoderModel } from '../config/Config.js'
import { SessionManager } from '../session/SessionManager.js'
import { messagesToAcpPrompt, extractCwdFromSystemPrompt } from '../adapter/MessagesToAcpAdapter.js'
import { acpToSdkMessages } from './AcpToSdkMessageBridge.js'
import type {
  Message,
  SystemPrompt,
  ThinkingConfig,
  Tools,
  CallModelOptions,
  CallModelYield,
} from '../types/claudeCode.js'
import type { Logger } from '../acp/AcpClient.js'

// ---------------------------------------------------------------------------
// Module-level singletons (lazy-initialized on first call)
// ---------------------------------------------------------------------------

let _sessionManager: SessionManager | null = null
let _logger: Logger | null = null

function getLogger(): Logger {
  if (_logger) return _logger
  const cfg = loadConfig()
  const level = cfg.logLevel
  const levels = ['debug', 'info', 'warn', 'error']
  const minIdx = levels.indexOf(level)
  const shouldLog = (l: string) => levels.indexOf(l) >= minIdx

  _logger = {
    debug: (...a) => shouldLog('debug') && console.error('[qoder-bridge:debug]', ...a),
    info:  (...a) => shouldLog('info')  && console.error('[qoder-bridge:info]',  ...a),
    warn:  (...a) => shouldLog('warn')  && console.error('[qoder-bridge:warn]',  ...a),
    error: (...a) => shouldLog('error') && console.error('[qoder-bridge:error]', ...a),
  }
  return _logger
}

function getSessionManager(): SessionManager {
  if (_sessionManager) return _sessionManager
  _sessionManager = new SessionManager(loadConfig(), getLogger())
  return _sessionManager
}

// ---------------------------------------------------------------------------
// acpCallModel
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for Claude Code's `queryModelWithStreaming`.
 *
 * Signature must exactly match `typeof queryModelWithStreaming` as defined in
 * Claude Code's src/services/api/claude.ts so the patch compiles cleanly.
 *
 * The `cwd` extra option is injected by the patch in productionDeps():
 *   callModel: (params, opts) => acpCallModel(params, { ...opts, cwd: getCwd() })
 */
export async function* acpCallModel(
  {
    messages,
    systemPrompt,
    tools: _tools,        // Qoder manages its own tools — we don't forward these
    thinkingConfig: _tc,  // Qoder manages thinking internally
    signal,
    options,
  }: {
    messages: Message[]
    systemPrompt: SystemPrompt
    thinkingConfig: ThinkingConfig
    tools: Tools
    signal: AbortSignal
    options: CallModelOptions & { sessionId?: string; cwd?: string }
  },
): AsyncGenerator<CallModelYield, void, unknown> {
  console.error('[qoder-bridge] acpCallModel generator function called')
  const logger = getLogger()
  const config = loadConfig()
  const sessionManager = getSessionManager()

  // --- Resolve cwd ---
  // Priority: explicitly injected cwd (from patched productionDeps) >
  //           parsed from system prompt (reliable fallback) >
  //           configured default
  const cwd =
    options.cwd ??
    extractCwdFromSystemPrompt(systemPrompt) ??
    config.defaultWorkdir ??
    homedir()

  // --- Resolve session ID ---
  // Injected by the patch from STATE.sessionId; fall back to a stable hash
  const sessionId = options.sessionId ?? deriveSessionId(messages)

  logger.info('acpCallModel called', { sessionId, cwd, model: options.model })

  // --- Cancel any in-flight task for this session ---
  await sessionManager.cancelActiveTask(sessionId)

  // --- Get or create ACP session ---
  const session = await sessionManager.getOrCreateSession(sessionId, cwd)

  // --- Switch Qoder model if specified ---
  const qoderModel = toQoderModel(options.model, config.modelDefault)
  try {
    await session.client.setModel(session.acpSessionId, qoderModel)
  } catch (err) {
    logger.warn('setModel failed (continuing with current model)', err)
  }

  // --- Build ACP prompt content ---
  const acpContent = messagesToAcpPrompt(messages, systemPrompt)
  if (acpContent.length === 0) {
    logger.warn('No ACP content produced from messages — sending empty prompt')
  }

  // --- Register abort controller ---
  const controller = new AbortController()
  const combinedSignal = combineSignals(signal, controller.signal)
  sessionManager.setActiveController(sessionId, controller)

  try {
    console.error('[qoder-bridge] About to delegate to acpToSdkMessages')
    yield* acpToSdkMessages(session, acpContent, combinedSignal)
    console.error('[qoder-bridge] acpToSdkMessages completed')
  } finally {
    sessionManager.clearActiveController(sessionId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable session ID from the first user message content when no
 * explicit session ID is provided.  This mirrors qoderclaw's MD5-based
 * fallback but uses a simpler hex hash.
 */
function deriveSessionId(messages: Message[]): string {
  const firstUser = messages.find((m) => m.type === 'user') as
    | { message?: { content?: unknown } }
    | undefined
  const seed = JSON.stringify(firstUser?.message?.content ?? 'default')
  // Simple djb2-like hash — good enough for a fallback session key
  let h = 5381
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h) ^ seed.charCodeAt(i)
    h = h >>> 0
  }
  return `derived_${h.toString(16).padStart(8, '0')}`
}

/**
 * Combine two AbortSignals: abort if either fires.
 */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (a.aborted || b.aborted) {
    controller.abort()
    return controller.signal
  }
  a.addEventListener('abort', abort, { once: true })
  b.addEventListener('abort', abort, { once: true })
  return controller.signal
}
