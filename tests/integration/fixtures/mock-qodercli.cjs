#!/usr/bin/env node

const { createInterface } = require('readline')

const responseText = process.env['MOCK_RESPONSE_TEXT'] ?? 'Hello from Qoder!'
const emitToolCall = process.env['MOCK_TOOL_CALL'] === '1'
const emitToolCallContentOnly = process.env['MOCK_TOOL_CALL_CONTENT_ONLY'] === '1'
const emitToolCallStructured = process.env['MOCK_TOOL_CALL_STRUCTURED'] === '1'
const errorMsg = process.env['MOCK_ERROR'] ?? ''
const delayMs = parseInt(process.env['MOCK_DELAY_MS'] ?? '0', 10)
const stopReason = process.env['MOCK_STOP_REASON'] ?? ''
const omitAgentFinish = process.env['MOCK_NO_AGENT_FINISH'] === '1'

let sessionIdCounter = 1

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function notify(method, params) {
  send({ method, params })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function handlePrompt(id) {
  if (errorMsg) {
    notify('session/update', {
      update: { sessionUpdate: 'agent_error', error: errorMsg },
    })
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }

  if (emitToolCall || emitToolCallContentOnly || emitToolCallStructured) {
    notify('session/update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_mock_1',
        title: emitToolCallStructured ? { type: 'text', text: 'Read' } : '`Bash`',
        rawInput: { command: 'echo hello', description: 'test' },
        kind: emitToolCallStructured ? 'read' : 'execute',
      },
    })
    if (delayMs) await sleep(delayMs)
    notify('session/update', {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_mock_1',
        ...(emitToolCallStructured
          ? {
              status: 'in_progress',
              title: { type: 'text', text: 'Read' },
              kind: 'read',
              rawOutput: [
                { content: { type: 'text', text: 'src/math.js' } },
                { content: { output: { lines: 7, bytes: 88 } } },
              ],
              content: [
                { type: 'content', content: { type: 'text', text: 'Loaded 1 file' } },
                { type: 'diff', content: { type: 'text', text: '@@ -1,3 +1,7 @@' } },
                { type: 'terminal', terminalId: 'term_1' },
              ],
              _meta: { terminal_output: 'preview', terminal_exit: 0 },
            }
          : emitToolCallContentOnly
            ? { content: [{ type: 'content', content: { type: 'text', text: 'hello from content-only' } }] }
            : { rawOutput: [{ content: 'hello\n', exitCode: 0 }] }),
      },
    })
    if (delayMs) await sleep(delayMs)
  }

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

  if (!omitAgentFinish) {
    notify('session/update', {
      update: { sessionUpdate: 'agent_finish' },
    })
  }

  send({ jsonrpc: '2.0', id, result: stopReason ? { stopReason } : {} })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  const id = msg['id']
  const method = msg['method']

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
    case 'session/cancel':
    case 'session/set_model':
    case 'session/set_mode':
      send({ jsonrpc: '2.0', id, result: {} })
      break

    case 'session/prompt':
      handlePrompt(id).catch((err) => {
        process.stderr.write(`mock-qodercli error: ${String(err)}\n`)
      })
      break

    default:
      send({ jsonrpc: '2.0', id, result: {} })
  }
})

rl.on('close', () => process.exit(0))
