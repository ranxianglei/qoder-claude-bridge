import { randomUUID } from 'crypto'
import type { AcpPromptContent, AcpUpdate } from '../acp/AcpTypes.js'
import type { SessionEntry } from '../session/SessionManager.js'
import type {
  AssistantAPIMessage,
  CallModelYield,
  SystemAPIErrorMessage,
} from '../types/claudeCode.js'

// ---------------------------------------------------------------------------
// ACP → SDKMessage bridge (AsyncGenerator)
// ---------------------------------------------------------------------------

/**
 * Drives a Qoder ACP prompt and yields Claude Code–compatible SDKMessage
 * objects.  This is the output side of the bridge — the returned generator
 * is handed directly to queryLoop() as if it came from queryModelWithStreaming.
 *
 * ACP update → yield mapping:
 *   agent_thought_chunk  → (ignored — internal thinking stream)
 *   agent_message_chunk  → buffered assistant text (single final message per turn)
 *   tool_call            → buffered inert status text (no Claude tool_use semantics)
 *   tool_call_update     → buffered inert status text (no tool_result semantics)
 *   agent_finish         → final AssistantMessage with stop_reason='end_turn', then return
 *   agent_error          → SystemAPIErrorMessage, then return
 *
 * Protocol versions:
 *   - Qoder v0.1.37+: session/prompt returns stopReason, agent_finish may not be sent
 *   - Older versions: agent_finish sent as notification
 */
export async function* acpToSdkMessages(
  session: SessionEntry,
  content: AcpPromptContent[],
  signal?: AbortSignal,
): AsyncGenerator<CallModelYield, void, unknown> {
  console.error('[qoder-bridge] Generator started')

  // Queue for updates arriving from ACP callbacks while generator is suspended
  const queue: AcpUpdate[] = []
  let finished = false
  let acpError: Error | null = null

  // Notify mechanism: a resolve function is set whenever the generator is
  // waiting for new items.  The onUpdate callback sets it to wake the loop.
  let notify: (() => void) | null = null
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      notify = resolve
    })

  const onUpdate = (update: AcpUpdate): void => {
    queue.push(update)
    const n = notify
    notify = null
    n?.()
  }

  // Launch the ACP sendPrompt in the background — it resolves when:
  //   - stopReason received (Qoder v0.1.37+), or
  //   - agent_finish update received (older versions)
  session.client
    .sendPrompt(session.acpSessionId, session.cwd, content, onUpdate, signal)
    .then(() => {
      // sendPrompt resolved (stopReason received or agent_finish)
      console.error('[qoder-bridge] sendPrompt resolved, setting finished=true')
      finished = true
      const n = notify
      notify = null
      n?.()
    })
    .catch((err: unknown) => {
      console.error('[qoder-bridge] sendPrompt rejected', err)
      acpError = err instanceof Error ? err : new Error(String(err))
      finished = true
      const n = notify
      notify = null
      n?.()
    })

  let assistantTextBuffer = ''
  let statusBuffer = ''
  let lastPartialText = ''
  let lastPartialAt = 0
  const messageId = `msg_qoder_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const PARTIAL_MIN_INTERVAL_MS = 120
  const PARTIAL_MIN_CHARS = 24

  const appendStatus = (line: string): void => {
    statusBuffer += `[Qoder] ${line}\n`
  }

  const buildFinalText = (): string => {
    if (statusBuffer && assistantTextBuffer) {
      return `${statusBuffer}${assistantTextBuffer}`
    }
    return statusBuffer || assistantTextBuffer
  }

  const shouldEmitPartial = (): boolean => {
    if (!assistantTextBuffer) return false
    if (assistantTextBuffer === lastPartialText) return false

    const now = Date.now()
    const deltaChars = assistantTextBuffer.length - lastPartialText.length
    const newestChar = assistantTextBuffer.at(-1) ?? ''
    const boundaryChar = newestChar === '\n' || /[.!?。！？]/.test(newestChar)
    const intervalElapsed = now - lastPartialAt >= PARTIAL_MIN_INTERVAL_MS

    return boundaryChar || deltaChars >= PARTIAL_MIN_CHARS || intervalElapsed
  }

  function* yieldPartial(): Generator<AssistantAPIMessage> {
    if (!shouldEmitPartial()) {
      return
    }
    lastPartialText = assistantTextBuffer
    lastPartialAt = Date.now()
    yield buildAssistantTextMessage(messageId, assistantTextBuffer, true)
  }

  // yieldFinal: yield the last assistant message with stop_reason='end_turn'.
  // Claude Code's queryLoop checks oE4(lastMsg, stop_reason): the last assistant
  // message must have content[last].type === 'text' (not empty content[]).
  // If we have buffered text, flush it as the terminal message.
  // If the buffer is empty (e.g. the turn only had tool calls), synthesise a
  // minimal text message so the content array is non-empty.
  function* yieldFinal(): Generator<AssistantAPIMessage> {
    const text = buildFinalText()
    assistantTextBuffer = ''
    statusBuffer = ''
    lastPartialText = ''
    if (text) {
      yield buildAssistantTextMessage(messageId, text, false /*terminal*/)
    } else {
      // No text content — yield a minimal non-empty terminal message
      yield buildAssistantTextMessage(messageId, '\u200b', false /*terminal*/)
    }
  }

  // Generator loop
  while (true) {
    // Drain the queue
    while (queue.length > 0) {
      const update = queue.shift()!

      if (update.sessionUpdate === 'agent_thought_chunk') {
        // Qoder v0.1.37+ sends thinking/reasoning as thought chunks.
        // We ignore them for now — they're internal to the agent.
        continue
      }

      if (update.sessionUpdate === 'agent_message_chunk') {
        assistantTextBuffer += update.content.text
        yield* yieldPartial()
        continue
      }

      if (update.sessionUpdate === 'tool_call') {
        appendStatus(`tool_call ${formatUnknownValue(update.title)}`)
        continue
      }

      if (update.sessionUpdate === 'tool_call_update') {
        const outputs = extractToolCallOutputs(update).join('\n')
        if (outputs) {
          appendStatus(`tool_call_update ${update.toolCallId}: ${outputs}`)
        } else {
          const statusParts = [
            update.status ? `status=${update.status}` : '',
            update.kind ? `kind=${update.kind}` : '',
            update.title ? `title=${formatUnknownValue(update.title)}` : '',
          ].filter(Boolean)
          appendStatus(
            statusParts.length > 0
              ? `tool_call_update ${update.toolCallId} ${statusParts.join(' ')}`
              : `tool_call_update ${update.toolCallId}`,
          )
        }
        continue
      }

      if (update.sessionUpdate === 'agent_finish') {
        yield* yieldFinal()
        console.error('[qoder-bridge] Generator complete (agent_finish)')
        return
      }

      if (update.sessionUpdate === 'agent_error') {
        const errMsg: SystemAPIErrorMessage = {
          type: 'system',
          subtype: 'api_error',
          error: new Error(update.error ?? 'Qoder agent error'),
        }
        yield errMsg
        return
      }
    }

    // Check terminal conditions before waiting
    if (acpError) {
      const errMsg: SystemAPIErrorMessage = {
        type: 'system',
        subtype: 'api_error',
        error: acpError,
      }
      yield errMsg
      return
    }

    if (finished) {
      console.error('[qoder-bridge] Generator finishing, textBufferLen=' + buildFinalText().length)
      yield* yieldFinal()
      console.error('[qoder-bridge] Generator complete')
      return
    }

    // Nothing in queue yet — suspend until notified
    await wait()
  }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildAssistantTextMessage(
  id: string,
  text: string,
  partial = false,
): AssistantAPIMessage {
  console.error('[qoder-bridge] buildAssistantTextMessage, text="' + text.slice(0, 50) + '...", partial=' + partial)
  return {
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'qoder',
      stop_reason: partial ? null : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

function extractToolCallOutputs(update: Extract<AcpUpdate, { sessionUpdate: 'tool_call_update' }>): string[] {
  const rawOutputs = collectToolCallRawOutput(update.rawOutput)

  if (rawOutputs.length > 0) {
    return rawOutputs
  }

  const contentOutputs = collectToolCallContent(update.content)
  if (contentOutputs.length > 0) {
    return contentOutputs
  }

  return collectToolCallMeta(update._meta)
}

function collectToolCallRawOutput(rawOutput: unknown): string[] {
  if (!Array.isArray(rawOutput)) {
    return formatUnknownValue(rawOutput) ? [formatUnknownValue(rawOutput)] : []
  }

  return rawOutput
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return formatUnknownValue(entry) ? [formatUnknownValue(entry)] : []
      }

      const rendered = formatUnknownValue(entry.content)
      const exitCode = typeof entry.exitCode === 'number' ? ` exit=${entry.exitCode}` : ''
      if (rendered) {
        return [`${rendered}${exitCode}`]
      }
      if (exitCode) {
        return [exitCode.trim()]
      }
      return []
    })
    .filter((line) => line.length > 0)
}

function collectToolCallContent(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return formatUnknownValue(content) ? [formatUnknownValue(content)] : []
  }

  return content
    .flatMap((entry) => {
      if (!isRecord(entry)) {
        return formatUnknownValue(entry) ? [formatUnknownValue(entry)] : []
      }

      const entryType = typeof entry.type === 'string' ? entry.type : ''
      const value = 'content' in entry ? formatUnknownValue(entry.content) : formatUnknownValue(entry)
      if (!value) {
        return []
      }

      if (entryType === 'diff') {
        return [`[diff]\n${value}`]
      }

      if (entryType === 'terminal') {
        return [`[terminal] ${value}`]
      }

      return [value]
    })
    .filter((line) => line.length > 0)
}

function collectToolCallMeta(meta: Record<string, unknown> | undefined): string[] {
  if (!meta) {
    return []
  }

  const rendered = formatUnknownValue(meta)
  return rendered ? [rendered] : []
}

function formatUnknownValue(value: unknown): string {
  const seen = new WeakSet<object>()

  const visit = (input: unknown): string => {
    if (input == null) return ''
    if (typeof input === 'string') return input
    if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') {
      return String(input)
    }

    if (Array.isArray(input)) {
      return input
        .map((item) => visit(item))
        .filter((item) => item.length > 0)
        .join('\n')
    }

    if (!isRecord(input)) {
      return ''
    }

    if (seen.has(input)) {
      return '[circular]'
    }
    seen.add(input)

    if (typeof input.text === 'string') {
      return input.text
    }

    if ('content' in input) {
      const nested = visit(input.content)
      if (nested) {
        return nested
      }
    }

    if (typeof input.output === 'string') {
      return input.output
    }

    if (Array.isArray(input.output)) {
      const nestedOutput = visit(input.output)
      if (nestedOutput) {
        return nestedOutput
      }
    }

    if (typeof input.type === 'string' && input.type === 'terminal') {
      const terminalBits = [
        typeof input.terminalId === 'string' ? `terminal=${input.terminalId}` : '',
        typeof input.command === 'string' ? `command=${input.command}` : '',
      ].filter(Boolean)
      return terminalBits.join(' ')
    }

    const json = safeJson(input)
    return json ?? ''
  }

  return visit(value).trim()
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}
