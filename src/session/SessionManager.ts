import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import { AcpClient, type Logger } from '../acp/AcpClient.js'
import type { Config } from '../config/Config.js'

// ---------------------------------------------------------------------------
// Session entry
// ---------------------------------------------------------------------------

export interface SessionEntry {
  client: AcpClient
  /** Qoder ACP session ID (stable across cwd changes via session/load) */
  acpSessionId: string
  /** Current working directory used in this session */
  cwd: string
  /** Epoch ms of last use — for idle GC */
  lastUsed: number
  /** AbortController for the currently active prompt task, if any */
  activeController: AbortController | null
}

// ---------------------------------------------------------------------------
// Persistence record
// ---------------------------------------------------------------------------

interface PersistedRecord {
  acpSessionId: string
  cwd: string
  lastUsed: number
}

type PersistedStore = Record<string, PersistedRecord>

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Maps Claude Code session IDs to Qoder ACP sessions.
 *
 * Key responsibilities:
 *  - Lazily spawn one AcpClient per Claude session
 *  - Detect cwd changes and call session/load (preserves history)
 *  - Persist acpSessionId so history survives Bridge restarts
 *  - GC idle sessions after configurable timeout
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>()
  private gcTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.loadPersistedMappings()
    this.startGc()
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the existing session for `claudeSessionId`, creating it if needed.
   * If the cwd has changed since the session was last used, calls ACP
   * `session/load` to switch directories without losing conversation history.
   */
  async getOrCreateSession(claudeSessionId: string, cwd: string): Promise<SessionEntry> {
    const existing = this.sessions.get(claudeSessionId)

    if (existing) {
      if (existing.cwd !== cwd) {
        this.logger.info('cwd changed — calling session/load', {
          claudeSessionId,
          oldCwd: existing.cwd,
          newCwd: cwd,
        })
        await existing.client.loadSession(existing.acpSessionId, cwd)
        existing.cwd = cwd
        this.persistMappings()
      }
      existing.lastUsed = Date.now()
      return existing
    }

    // --- New session ---
    this.logger.info('Creating new ACP session', { claudeSessionId, cwd })

    const client = new AcpClient({
      cmd: this.config.qoderCliCmd,
      workdir: cwd,
      logger: this.logger,
    })

    // Wire up exit → cleanup
    client.once('exit', () => {
      this.logger.warn('AcpClient exited, removing session', { claudeSessionId })
      this.sessions.delete(claudeSessionId)
      this.persistMappings()
    })

    await client.start()
    const acpSessionId = await client.newSession(cwd)

    const entry: SessionEntry = {
      client,
      acpSessionId,
      cwd,
      lastUsed: Date.now(),
      activeController: null,
    }

    this.sessions.set(claudeSessionId, entry)
    this.persistMappings()
    return entry
  }

  /**
   * Cancel any active prompt task for `claudeSessionId`.
   * Called before starting a new prompt so only one task runs at a time.
   */
  async cancelActiveTask(claudeSessionId: string): Promise<void> {
    const entry = this.sessions.get(claudeSessionId)
    if (!entry?.activeController) return

    this.logger.info('Cancelling active task', { claudeSessionId })
    entry.activeController.abort()
    await entry.client.cancelSession(entry.acpSessionId)
    entry.activeController = null
  }

  /** Register a new AbortController as the active task for a session. */
  setActiveController(claudeSessionId: string, controller: AbortController): void {
    const entry = this.sessions.get(claudeSessionId)
    if (entry) entry.activeController = controller
  }

  /** Clear the active controller once a task completes. */
  clearActiveController(claudeSessionId: string): void {
    const entry = this.sessions.get(claudeSessionId)
    if (entry) entry.activeController = null
  }

  /** Gracefully shut down all sessions. */
  async destroy(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer)
    for (const [id, entry] of this.sessions) {
      this.logger.info('Destroying session', { claudeSessionId: id })
      entry.client.destroy()
    }
    this.sessions.clear()
  }

  getStats(): { total: number; active: number } {
    let active = 0
    for (const entry of this.sessions.values()) {
      if (entry.activeController) active++
    }
    return { total: this.sessions.size, active }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persistMappings(): void {
    try {
      const store: PersistedStore = {}
      for (const [claudeId, entry] of this.sessions) {
        store[claudeId] = {
          acpSessionId: entry.acpSessionId,
          cwd: entry.cwd,
          lastUsed: entry.lastUsed,
        }
      }
      mkdirSync(dirname(this.config.sessionStore), { recursive: true })
      writeFileSync(this.config.sessionStore, JSON.stringify(store, null, 2), 'utf-8')
    } catch (err) {
      this.logger.warn('Failed to persist session mappings', err)
    }
  }

  private loadPersistedMappings(): void {
    if (!existsSync(this.config.sessionStore)) return
    try {
      const raw = readFileSync(this.config.sessionStore, 'utf-8')
      const store = JSON.parse(raw) as PersistedStore
      // We store metadata only; actual AcpClient instances are created lazily
      // on first getOrCreateSession call. We stash the acpSessionId so it can
      // be reloaded rather than starting a brand-new Qoder session.
      this.logger.info('Loaded persisted session mappings', {
        count: Object.keys(store).length,
      })
      // The persisted entries feed into getOrCreateSession via a side channel:
      // we keep a separate Map for "known acpSessionIds to restore"
      this._restorable = store
    } catch (err) {
      this.logger.warn('Failed to load persisted session mappings (ignored)', err)
    }
  }

  // acpSessionId restore hints (populated from persisted store)
  private _restorable: PersistedStore = {}

  /**
   * If we have a persisted acpSessionId for this claudeSessionId, try to
   * resume it via session/load instead of creating a fresh one.
   */
  async tryRestoreSession(
    claudeSessionId: string,
    client: AcpClient,
    cwd: string,
  ): Promise<string> {
    const hint = this._restorable[claudeSessionId]
    if (hint) {
      try {
        await client.loadSession(hint.acpSessionId, cwd)
        this.logger.info('Restored persisted ACP session', {
          claudeSessionId,
          acpSessionId: hint.acpSessionId,
        })
        delete this._restorable[claudeSessionId]
        return hint.acpSessionId
      } catch (err) {
        this.logger.warn('Failed to restore persisted session, creating new', err)
      }
    }
    return client.newSession(cwd)
  }

  // -------------------------------------------------------------------------
  // GC
  // -------------------------------------------------------------------------

  private startGc(): void {
    // Run GC every 5 minutes
    this.gcTimer = setInterval(() => this.gc(), 5 * 60 * 1000)
    // Don't keep the process alive just for GC
    this.gcTimer.unref?.()
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, entry] of this.sessions) {
      const idle = now - entry.lastUsed
      if (idle > this.config.sessionIdleMs) {
        this.logger.info('GC: removing idle session', { claudeSessionId: id, idleMs: idle })
        entry.client.destroy()
        this.sessions.delete(id)
      }
    }
    this.persistMappings()
  }
}
