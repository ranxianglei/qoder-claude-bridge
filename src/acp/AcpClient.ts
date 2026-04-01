import { EventEmitter } from 'events'
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createInterface } from 'readline'
import type {
  AcpUpdate,
  AcpPermissionResult,
  AcpPromptContent,
  AcpInitializeResult,
  AcpSessionNewResult,
} from './AcpTypes.js'

// ---------------------------------------------------------------------------
// Logger (thin wrapper — replaced by pino in production via Config)
// ---------------------------------------------------------------------------
export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// ---------------------------------------------------------------------------
// AcpClient options
// ---------------------------------------------------------------------------
export interface AcpClientOptions {
  /** Path to qodercli executable */
  cmd: string
  /** Working directory for the qodercli process itself */
  workdir: string
  logger?: Logger
  /**
   * Optional spawn function override — used in tests to inject a mock process.
   * Signature: (cmd, args, options) => ChildProcess
   */
  spawnFn?: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess
}

// ---------------------------------------------------------------------------
// Pending RPC call
// ---------------------------------------------------------------------------
interface PendingCall {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
}

// ---------------------------------------------------------------------------
// AcpClient
// ---------------------------------------------------------------------------

/**
 * Manages a single `qodercli --acp` child process and implements the full
 * ACP JSON-RPC 2.0 protocol over stdio.
 *
 * Message type discrimination (from qoderclaw reverse-engineering):
 *   has id + has method  → Qoder is requesting something from us (e.g. permission)
 *   has id, no method    → Response to one of our requests
 *   no id + has method   → Notification / streaming update
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private pending = new Map<number, PendingCall>()
  private nextId = 1
  private _initialized = false
  private readonly logger: Logger

  constructor(private readonly options: AcpClientOptions) {
    super()
    this.logger = options.logger ?? noopLogger
  }

  get initialized(): boolean {
    return this._initialized
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Spawn qodercli --acp and complete the ACP initialize handshake. */
  async start(): Promise<void> {
    if (this.proc) throw new Error('AcpClient already started')

    this.logger.debug('Spawning qodercli', { cmd: this.options.cmd, cwd: this.options.workdir })

    const spawnFn = this.options.spawnFn ?? spawn
    this.proc = spawnFn(this.options.cmd, ['--acp'], {
      cwd: this.options.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    // Wire up stderr to our logger
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.logger.debug('[qodercli stderr]', chunk.toString().trimEnd())
    })

    // readline — no line-length limit (unlike Python asyncio StreamReader)
    const rl = createInterface({
      input: this.proc.stdout!,
      crlfDelay: Infinity,
    })
    rl.on('line', (line) => this.onLine(line))

    this.proc.on('exit', (code, signal) => {
      this.logger.warn('qodercli exited', { code, signal })
      this._initialized = false
      // Reject all pending calls so callers don't hang
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`qodercli exited (code=${code}, signal=${signal})`))
        this.pending.delete(id)
      }
      this.emit('exit', code, signal)
    })

    this.proc.on('error', (err) => {
      this.logger.error('qodercli process error', err)
      this.emit('error', err)
    })

    // ACP handshake
    const result = await this.call<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    this._initialized = true
    this.logger.info('ACP initialized', { capabilities: result.agentCapabilities })
  }

  /** Terminate the child process and clean up. */
  destroy(): void {
    if (!this.proc) return
    this.logger.info('Destroying AcpClient')
    this.proc.kill()
    this.proc = null
    this._initialized = false
    for (const [id, pending] of this.pending) {
      pending.reject(new Error('AcpClient destroyed'))
      this.pending.delete(id)
    }
  }

  // -------------------------------------------------------------------------
  // ACP session management
  // -------------------------------------------------------------------------

  /** Create a new Qoder session in the given directory. Returns the ACP session ID. */
  async newSession(cwd: string): Promise<string> {
    this.assertReady()
    const result = await this.call<AcpSessionNewResult>('session/new', { cwd })
    this.logger.info('ACP session/new', { acpSessionId: result.sessionId, cwd })
    return result.sessionId
  }

  /** Load (resume) an existing session, optionally switching working directory. */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    this.assertReady()
    await this.call('session/load', { sessionId, cwd })
    this.logger.info('ACP session/load', { sessionId, cwd })
  }

  /** Cancel the active task in a session. */
  async cancelSession(sessionId: string): Promise<void> {
    if (!this._initialized) return
    try {
      await this.call('session/cancel', { sessionId })
    } catch (err) {
      this.logger.warn('session/cancel failed (ignored)', err)
    }
  }

  /** Switch the Qoder model used in a session. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertReady()
    await this.call('session/set_model', { sessionId, modelId })
  }

  /** Switch the Qoder operating mode in a session. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    this.assertReady()
    await this.call('session/set_mode', { sessionId, modeId })
  }

  // -------------------------------------------------------------------------
  // Prompt / streaming
  // -------------------------------------------------------------------------

  /**
   * Send a prompt to the given session and stream back ACP updates via the
   * onUpdate callback. Resolves when:
   *   - session/prompt response contains stopReason (Qoder v0.1.37+), or
   *   - agent_finish update is received (older Qoder versions), or
   *   - agent_error update is received.
   */
  async sendPrompt(
    sessionId: string,
    cwd: string,
    content: AcpPromptContent[],
    onUpdate: (update: AcpUpdate) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertReady()

    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('AbortError'))
        return
      }

      let resolved = false
      const onAbort = () => {
        this.cancelSession(sessionId).catch(() => {})
        reject(new Error('AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const updateHandler = (update: AcpUpdate) => {
        if (resolved) return

        try {
          onUpdate(update)
        } catch (err) {
          this.logger.warn('onUpdate callback threw', err)
        }

        if (update.sessionUpdate === 'agent_finish') {
          resolved = true
          signal?.removeEventListener('abort', onAbort)
          this.off('update', updateHandler)
          resolve()
        } else if (update.sessionUpdate === 'agent_error') {
          resolved = true
          signal?.removeEventListener('abort', onAbort)
          this.off('update', updateHandler)
          const msg = update.error ?? 'Qoder agent error'
          reject(new Error(msg))
        }
      }

      this.on('update', updateHandler)

      // Qoder v0.1.37+ returns stopReason directly in the response.
      // Older versions send agent_finish as a notification.
      this.call<{ stopReason?: string }>('session/prompt', { sessionId, cwd, prompt: content })
        .then((result) => {
          if (resolved) return
          // New protocol: stopReason indicates completion
          if (result?.stopReason) {
            resolved = true
            signal?.removeEventListener('abort', onAbort)
            this.off('update', updateHandler)
            resolve()
          }
          // Old protocol: wait for agent_finish notification (handled in updateHandler)
        })
        .catch((err) => {
          if (resolved) return
          signal?.removeEventListener('abort', onAbort)
          this.off('update', updateHandler)
          reject(err)
        })
    })
  }

  // -------------------------------------------------------------------------
  // Low-level JSON-RPC
  // -------------------------------------------------------------------------

  private call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private send(msg: unknown): void {
    if (!this.proc?.stdin) {
      throw new Error('qodercli process not running')
    }
    const line = JSON.stringify(msg) + '\n'
    this.proc.stdin.write(line)
    this.logger.debug('→ ACP', msg)
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      this.logger.warn('Unparseable ACP line', { line: trimmed })
      return
    }

    this.logger.debug('← ACP', msg)

    const hasId = 'id' in msg && msg['id'] !== undefined
    const hasMethod = 'method' in msg && typeof msg['method'] === 'string'

    if (hasId && hasMethod) {
      // Qoder is requesting something from us (e.g. session/request_permission)
      this.handleIncomingRequest(msg)
    } else if (hasId) {
      // Response to one of our pending calls
      const id = msg['id'] as number
      const pending = this.pending.get(id)
      if (!pending) {
        this.logger.warn('No pending call for id', { id })
        return
      }
      this.pending.delete(id)
      if ('error' in msg && msg['error']) {
        const err = msg['error'] as { message?: string; code?: number }
        pending.reject(new Error(err.message ?? 'ACP error'))
      } else {
        pending.resolve(msg['result'])
      }
    } else if (hasMethod) {
      // Streaming notification
      if (msg['method'] === 'session/update') {
        const params = msg['params'] as { update: AcpUpdate }
        if (params?.update) {
          this.emit('update', params.update)
        }
      } else {
        this.logger.debug('Unknown ACP notification method', { method: msg['method'] })
      }
    }
  }

  private handleIncomingRequest(msg: Record<string, unknown>): void {
    const method = msg['method'] as string
    const id = msg['id'] as number

    if (method === 'session/request_permission') {
      // Auto-approve all tool calls (equivalent to --yolo mode)
      const response: AcpPermissionResult = {
        outcome: { outcome: 'selected', optionId: 'allow_always' },
      }
      this.send({ jsonrpc: '2.0', id, result: response })
      this.logger.debug('Auto-approved permission request', { id })
    } else {
      // Unknown request from Qoder — send a generic ok to avoid hanging
      this.logger.warn('Unknown incoming ACP request, sending empty result', { method, id })
      this.send({ jsonrpc: '2.0', id, result: {} })
    }
  }

  private assertReady(): void {
    if (!this._initialized || !this.proc) {
      throw new Error('AcpClient not initialized — call start() first')
    }
  }
}
