#!/usr/bin/env node
/**
 * tests/integration/fixtures/mock-qodercli.ts
 *
 * A minimal mock of `qodercli --acp` that speaks the ACP JSON-RPC 2.0
 * protocol over stdin/stdout.
 *
 * Behavior controlled by environment variables:
 *   MOCK_RESPONSE_TEXT   — text to stream back (default: "Hello from Qoder!")
 *   MOCK_TOOL_CALL       — if "1", emit a tool_call + tool_call_update before text
 *   MOCK_ERROR           — if set, emit agent_error with this message
 *   MOCK_DELAY_MS        — ms delay between text chunks (default: 0)
 */

import { createInterface } from 'readline'

const responseText = process.env['MOCK_RESPONSE_TEXT'] ?? 'Hello from Qoder!'
const emitToolCall = process.env['MOCK_TOOL_CALL'] === '1'
const errorMsg = process.env['MOCK_ERROR'] ?? ''
const delayMs = parseInt(process.env['MOCK_DELAY_MS'] ?? '0', 10)

let sessionIdCounter = 1

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function notify(method: string, params: unknown): void {
  send({ method, params })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function handlePrompt(id: number, sessionId: string): Promise<void> {
  if (errorMsg) {
    notify('session/update', {
      update: { sessionUpdate: 'agent_error', error: errorMsg },
    })
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (emitToolCall) {
    notify('session/update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_mock_1',
        title: '`Bash`',
        rawInput: { command: 'echo hello', description: 'test' },
        kind: 'execute',
      },
    })
    if (delayMs) await sleep(delayMs)
    notify('session/update', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_mock_1',
        rawOutput: [{ content: 'hello\n', exitCode: 0 }],
      },
    })
    if (delayMs) await sleep(delayMs)
  }

  // Stream response text in small chunks
  const chunkSize = 5
  for (let i = 0; i < responseText.length; i += chunkSize) {
    const chunk = responseText.slice(i, i + chunkSize)
    notify('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk },
      },
    })
    if (delayMs) await sleep(delayMs)
  }

  notify('session/update', {
    update: { sessionUpdate: 'agent_finish' },
  })

  // Respond to the session/prompt request itself
  send({ jsonrpc: '2.0', id, result: {} })
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line: string) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return
  }

  const id = msg['id'] as number
  const method = msg['method'] as string
  const params = msg['params'] as Record<string, unknown> | undefined

  switch (method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id, result: { agentCapabilities: {} } })
      break

    case 'session/new': {
      const sessionId = `mock-session-${sessionIdCounter++}`
      send({ jsonrpc: '2.0', id, result: { sessionId } })
      break
    }

    case 'session/load':
      send({ jsonrpc: '2.0', id, result: {} })
      break

    case 'session/cancel':
      send({ jsonrpc: '2.0', id, result: {} })
      break

    case 'session/set_model':
    case 'session/set_mode':
      send({ jsonrpc: '2.0', id, result: {} })
      break

    case 'session/prompt': {
      const sessionId = (params?.['sessionId'] as string) ?? 'unknown'
      // Handle async without blocking readline
      handlePrompt(id, sessionId).catch((err: unknown) => {
        process.stderr.write(`mock-qodercli error: ${String(err)}\n`)
      })
      break
    }

    default:
      send({ jsonrpc: '2.0', id, result: {} })
  }
})

rl.on('close', () => process.exit(0))
