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
let _warnedMissingSessionId = false

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

  const claudeSessionId = options.sessionId
  const hasDurableSession = typeof claudeSessionId === 'string' && claudeSessionId.length > 0

  if (!hasDurableSession && !_warnedMissingSessionId) {
    _warnedMissingSessionId = true
    logger.warn('Claude sessionId unavailable; using ephemeral ACP sessions without durable restore')
  }

  logger.info('acpCallModel called', {
    sessionId: claudeSessionId ?? '(ephemeral)',
    cwd,
    model: options.model,
    durableSession: hasDurableSession,
  })

  if (hasDurableSession) {
    await sessionManager.cancelActiveTask(claudeSessionId)
  }

  const session = hasDurableSession
    ? await sessionManager.getOrCreateSession(claudeSessionId, cwd)
    : await sessionManager.createEphemeralSession(cwd)

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
  if (hasDurableSession) {
    sessionManager.setActiveController(claudeSessionId, controller)
  }

  try {
    console.error('[qoder-bridge] About to delegate to acpToSdkMessages')
    yield* acpToSdkMessages(session, acpContent, combinedSignal)
    console.error('[qoder-bridge] acpToSdkMessages completed')
  } finally {
    if (hasDurableSession) {
      sessionManager.clearActiveController(claudeSessionId)
    } else {
      session.client.destroy()
    }
  }
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
