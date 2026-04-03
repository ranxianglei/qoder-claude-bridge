import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpClient, type Logger } from '../acp/AcpClient.js'
import { SessionManager } from './SessionManager.js'
import type { Config } from '../config/Config.js'

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

function makeConfig(sessionStore: string): Config {
  return {
    qoderCliCmd: 'qodercli',
    defaultWorkdir: '/tmp',
    sessionIdleMs: 60_000,
    autoApproveTools: true,
    sessionStore,
    logLevel: 'info',
    modelDefault: 'auto',
  }
}

describe('SessionManager restore behavior', () => {
  let tempDir: string
  let manager: SessionManager | null = null

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-manager-test-'))
    vi.restoreAllMocks()
  })

  afterEach(async () => {
    if (manager) {
      await manager.destroy()
      manager = null
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reuses persisted ACP session ID via tryRestoreSession on first access', async () => {
    const sessionStore = join(tempDir, 'sessions.json')
    const persisted = {
      claudeA: {
        acpSessionId: 'persisted-session-1',
        cwd: '/old',
        lastUsed: 1,
      },
    }
    writeFileSync(sessionStore, JSON.stringify(persisted), 'utf-8')

    vi.spyOn(AcpClient.prototype, 'start').mockResolvedValue(undefined)
    const loadSpy = vi.spyOn(AcpClient.prototype, 'loadSession').mockResolvedValue(undefined)
    const newSpy = vi.spyOn(AcpClient.prototype, 'newSession').mockResolvedValue('new-session-should-not-be-used')

    manager = new SessionManager(makeConfig(sessionStore), logger)
    const entry = await manager.getOrCreateSession('claudeA', '/work')

    expect(entry.acpSessionId).toBe('persisted-session-1')
    expect(loadSpy).toHaveBeenCalledWith('persisted-session-1', '/work')
    expect(newSpy).not.toHaveBeenCalled()
  })

  it('falls back to newSession when restore fails and clears stale hint', async () => {
    const sessionStore = join(tempDir, 'sessions.json')
    const persisted = {
      claudeB: {
        acpSessionId: 'stale-session',
        cwd: '/old',
        lastUsed: 1,
      },
    }
    writeFileSync(sessionStore, JSON.stringify(persisted), 'utf-8')

    vi.spyOn(AcpClient.prototype, 'start').mockResolvedValue(undefined)
    const loadSpy = vi.spyOn(AcpClient.prototype, 'loadSession').mockRejectedValue(new Error('restore failed'))
    const newSpy = vi.spyOn(AcpClient.prototype, 'newSession').mockResolvedValue('fresh-session')

    manager = new SessionManager(makeConfig(sessionStore), logger)
    const first = await manager.getOrCreateSession('claudeB', '/work')
    expect(first.acpSessionId).toBe('fresh-session')

    first.client.emit('exit', 0, null)

    const second = await manager.getOrCreateSession('claudeB', '/work-again')
    expect(second.acpSessionId).toBe('fresh-session')

    expect(loadSpy).toHaveBeenCalledTimes(1)
    expect(newSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps persisted mapping format compatible', async () => {
    const sessionStore = join(tempDir, 'nested', 'sessions.json')
    mkdirSync(join(tempDir, 'nested'), { recursive: true })

    vi.spyOn(AcpClient.prototype, 'start').mockResolvedValue(undefined)
    vi.spyOn(AcpClient.prototype, 'loadSession').mockResolvedValue(undefined)
    vi.spyOn(AcpClient.prototype, 'newSession').mockResolvedValue('format-session')

    manager = new SessionManager(makeConfig(sessionStore), logger)
    await manager.getOrCreateSession('claudeC', '/compat')

    const parsed = JSON.parse(readFileSync(sessionStore, 'utf-8')) as Record<string, Record<string, unknown>>
    const record = parsed['claudeC']

    expect(record).toBeDefined()
    if (!record) {
      throw new Error('Expected persisted record for claudeC')
    }

    expect(Object.keys(record).sort()).toEqual(['acpSessionId', 'cwd', 'lastUsed'])
    expect(record['acpSessionId']).toBe('format-session')
    expect(record['cwd']).toBe('/compat')
    expect(typeof record['lastUsed']).toBe('number')
  })

  it('creates ephemeral sessions without persisting or restoring them', async () => {
    const sessionStore = join(tempDir, 'sessions.json')
    const persisted = {
      claudeEphemeral: {
        acpSessionId: 'persisted-session-should-not-load',
        cwd: '/old',
        lastUsed: 1,
      },
    }
    writeFileSync(sessionStore, JSON.stringify(persisted), 'utf-8')

    vi.spyOn(AcpClient.prototype, 'start').mockResolvedValue(undefined)
    const loadSpy = vi.spyOn(AcpClient.prototype, 'loadSession').mockResolvedValue(undefined)
    const newSpy = vi.spyOn(AcpClient.prototype, 'newSession').mockResolvedValue('ephemeral-session')

    manager = new SessionManager(makeConfig(sessionStore), logger)
    const entry = await manager.createEphemeralSession('/tmp/ephemeral')

    expect(entry.acpSessionId).toBe('ephemeral-session')
    expect(loadSpy).not.toHaveBeenCalled()
    expect(newSpy).toHaveBeenCalledWith('/tmp/ephemeral')

    const parsed = JSON.parse(readFileSync(sessionStore, 'utf-8')) as Record<string, Record<string, unknown>>
    expect(parsed['claudeEphemeral']?.['acpSessionId']).toBe('persisted-session-should-not-load')
    expect(parsed['ephemeral-session']).toBeUndefined()

    entry.client.destroy()
  })
})
