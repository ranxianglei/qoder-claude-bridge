/**
 * Integration tests for the Qoder Claude Bridge.
 *
 * Spawns mock-qodercli as a real child process via the AcpClient.spawnFn
 * injection point, then exercises the full pipeline:
 *   AcpClient → SessionManager → MessagesToAcpAdapter → AcpToSdkMessageBridge
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn, type SpawnOptions } from 'child_process'
import { AcpClient } from '../../src/acp/AcpClient.js'
import { acpToSdkMessages } from '../../src/bridge/AcpToSdkMessageBridge.js'
import {
  messagesToAcpPrompt,
  extractCwdFromSystemPrompt,
} from '../../src/adapter/MessagesToAcpAdapter.js'
import { resetConfig } from '../../src/config/Config.js'
import type { AssistantAPIMessage, UserMessage } from '../../src/types/claudeCode.js'
import type { SessionEntry } from '../../src/session/SessionManager.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const MOCK_FIXTURE = resolve(__dirname, 'fixtures/mock-qodercli.cjs')

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeMockClient(mockEnv: Record<string, string> = {}): AcpClient {
  return new AcpClient({
    cmd: 'unused', // overridden by spawnFn
    workdir: '/tmp',
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    spawnFn: (_cmd: string, _args: string[], opts: SpawnOptions) =>
      spawn(process.execPath, [MOCK_FIXTURE], {
        ...opts,
        env: { ...process.env, ...mockEnv },
      }),
  })
}

/** Collect all yielded messages from acpToSdkMessages. */
async function collect(
  client: AcpClient,
  sessionId: string,
): Promise<{ assistant: AssistantAPIMessage[]; errors: unknown[] }> {
  const entry: SessionEntry = {
    client,
    acpSessionId: sessionId,
    cwd: '/tmp/test',
    lastUsed: Date.now(),
    activeController: null,
  }
  const content = [{ type: 'text' as const, text: 'test prompt' }]
  const assistant: AssistantAPIMessage[] = []
  const errors: unknown[] = []

  for await (const msg of acpToSdkMessages(entry, content)) {
    if (msg.type === 'assistant') assistant.push(msg as AssistantAPIMessage)
    if (msg.type === 'system') errors.push(msg)
  }
  return { assistant, errors }
}

// ---------------------------------------------------------------------------
// AcpClient tests
// ---------------------------------------------------------------------------

describe('AcpClient', () => {
  let client: AcpClient

  afterEach(() => client?.destroy())
  beforeEach(() => resetConfig())

  it('initializes with mock qodercli', async () => {
    client = makeMockClient()
    await client.start()
    expect(client.initialized).toBe(true)
  })

  it('creates a new session', async () => {
    client = makeMockClient()
    await client.start()
    const id = await client.newSession('/tmp/test')
    expect(id).toMatch(/^mock-session-/)
  })

  it('loads an existing session without error', async () => {
    client = makeMockClient()
    await client.start()
    const id = await client.newSession('/tmp/test')
    await expect(client.loadSession(id, '/tmp/other')).resolves.toBeUndefined()
  })

  it('streams text via sendPrompt', async () => {
    client = makeMockClient({ MOCK_RESPONSE_TEXT: 'Hello Bridge!' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const chunks: string[] = []
    await client.sendPrompt(
      sessionId,
      '/tmp/test',
      [{ type: 'text', text: 'hi' }],
      (update) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          chunks.push(update.content.text)
        }
      },
    )
    expect(chunks.join('')).toBe('Hello Bridge!')
  })

  it('rejects on agent_error', async () => {
    client = makeMockClient({ MOCK_ERROR: 'boom' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    await expect(
      client.sendPrompt(sessionId, '/tmp/test', [{ type: 'text', text: 'hi' }], () => {}),
    ).rejects.toThrow('boom')
  })

  it('rejects immediately on pre-aborted signal', async () => {
    client = makeMockClient()
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const ctrl = new AbortController()
    ctrl.abort()

    await expect(
      client.sendPrompt(sessionId, '/tmp/test', [{ type: 'text', text: 'hi' }], () => {}, ctrl.signal),
    ).rejects.toThrow('AbortError')
  })
})

// ---------------------------------------------------------------------------
// MessagesToAcpAdapter tests
// ---------------------------------------------------------------------------

describe('MessagesToAcpAdapter', () => {
  it('extracts cwd from system prompt array', () => {
    const sys = ['<env>\nWorking directory: /home/user/proj\n</env>']
    expect(extractCwdFromSystemPrompt(sys)).toBe('/home/user/proj')
  })

  it('returns undefined when no cwd present', () => {
    expect(extractCwdFromSystemPrompt(['no dir info'])).toBeUndefined()
  })

  it('returns undefined for empty system prompt', () => {
    expect(extractCwdFromSystemPrompt(undefined)).toBeUndefined()
    expect(extractCwdFromSystemPrompt([])).toBeUndefined()
  })

  it('only forwards last user message', () => {
    const messages: UserMessage[] = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'last' }] } },
    ]
    const result = messagesToAcpPrompt(messages, [])
    const texts = result.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text)
    expect(texts).toContain('last')
    expect(texts).not.toContain('first')
  })

  it('converts base64 image to ACP format', () => {
    const messages: UserMessage[] = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as never,
            { type: 'text', text: 'describe' },
          ],
        },
      },
    ]
    const result = messagesToAcpPrompt(messages, [])
    const img = result.find((b) => b.type === 'image')
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/png', data: 'abc' })
  })

  it('strips boilerplate env block from system prompt', () => {
    const sys = [
      'Custom instructions here.',
      'Here is useful information about the environment you are running in:\n<env>\nWorking directory: /tmp\n</env>',
    ]
    const messages: UserMessage[] = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ]
    const result = messagesToAcpPrompt(messages, sys)
    const all = result.map((b) => ('text' in b ? b.text : '')).join('')
    expect(all).toContain('Custom instructions')
    expect(all).not.toContain('Working directory')
  })

  it('returns empty array when messages list is empty', () => {
    expect(messagesToAcpPrompt([], [])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AcpToSdkMessageBridge tests
// ---------------------------------------------------------------------------

describe('AcpToSdkMessageBridge', () => {
  afterEach(() => resetConfig())

  it('yields one finalized assistant text message and preserves exact text', async () => {
    const exactText = '  Works!  \n'
    const client = makeMockClient({ MOCK_RESPONSE_TEXT: exactText })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant, errors } = await collect(client, sessionId)
    expect(errors).toHaveLength(0)
    expect(assistant).toHaveLength(1)

    const onlyText = assistant[0]?.message.content.find((c) => c.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    expect(onlyText?.text).toBe(exactText)

    const last = assistant.at(-1)
    expect(last?.message.stop_reason).toBe('end_turn')
    expect(last?.message.model).toBe('qoder')
    client.destroy()
  })

  it('surfaces tool activity as inert text and does not emit tool_use blocks', async () => {
    const client = makeMockClient({ MOCK_TOOL_CALL: '1', MOCK_RESPONSE_TEXT: 'done' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant } = await collect(client, sessionId)
    expect(assistant).toHaveLength(1)

    const hasToolUse = assistant.some((m) => m.message.content.some((c) => c.type === 'tool_use'))
    expect(hasToolUse).toBe(false)

    const allText = assistant
      .flatMap((m) => m.message.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')

    expect(allText).toContain('[Qoder] tool_call `Bash`')
    expect(allText).toContain('[Qoder] tool_call_update tc_mock_1:')
    expect(allText).toContain('done')
    client.destroy()
  })

  it('handles tool_call_update content when rawOutput is absent', async () => {
    const client = makeMockClient({ MOCK_TOOL_CALL_CONTENT_ONLY: '1', MOCK_RESPONSE_TEXT: 'done' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant, errors } = await collect(client, sessionId)
    expect(errors).toHaveLength(0)
    expect(assistant).toHaveLength(1)

    const allText = assistant
      .flatMap((m) => m.message.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')

    expect(allText).toContain('[Qoder] tool_call `Bash`')
    expect(allText).toContain('[Qoder] tool_call_update tc_mock_1: hello from content-only')
    expect(allText).toContain('done')
    client.destroy()
  })

  it('renders structured tool payloads without object stringification', async () => {
    const client = makeMockClient({ MOCK_TOOL_CALL_STRUCTURED: '1', MOCK_RESPONSE_TEXT: 'done' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant, errors } = await collect(client, sessionId)
    expect(errors).toHaveLength(0)
    expect(assistant).toHaveLength(1)

    const allText = assistant
      .flatMap((m) => m.message.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')

    expect(allText).toContain('[Qoder] tool_call Read')
    expect(allText).toContain('src/math.js')
    expect(allText).toContain('{"lines":7,"bytes":88}')
    expect(allText).not.toContain('[object Object]')
    expect(allText).toContain('done')
    client.destroy()
  })

  it('completes when session/prompt returns stopReason without agent_finish', async () => {
    const client = makeMockClient({
      MOCK_RESPONSE_TEXT: 'from-stop-reason',
      MOCK_STOP_REASON: 'end_turn',
      MOCK_NO_AGENT_FINISH: '1',
    })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant, errors } = await collect(client, sessionId)
    expect(errors).toHaveLength(0)
    expect(assistant).toHaveLength(1)

    const text = assistant
      .flatMap((m) => m.message.content)
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: string }).text)
      .join('')
    expect(text).toBe('from-stop-reason')

    expect(assistant[0]?.message.stop_reason).toBe('end_turn')
    client.destroy()
  })

  it('yields SystemAPIErrorMessage on agent_error', async () => {
    const client = makeMockClient({ MOCK_ERROR: 'qoder failed' })
    await client.start()
    const sessionId = await client.newSession('/tmp/test')

    const { assistant, errors } = await collect(client, sessionId)
    expect(errors.length).toBeGreaterThan(0)
    const err = errors[0] as { type: string; subtype: string; error: Error }
    expect(err.type).toBe('system')
    expect(err.subtype).toBe('api_error')
    expect(err.error.message).toContain('qoder failed')
    client.destroy()
  })
})
