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
 *   agent_message_chunk  → AssistantMessage with text content block
 *   tool_call            → AssistantMessage with tool_use content block
 *   tool_call_update     → (absorbed — tool results handled by Qoder internally)
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

  // Accumulate text chunks into a single assistant message per "turn".
  // Qoder streams many small chunks; we buffer and flush on tool_call or finish.
  let textBuffer = ''
  const messageId = `msg_qoder_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  // First yield stream_request_start to match Claude Code's expected protocol
  // Note: This is a simple signal that the stream is starting, it's not processed as a message
  yield { type: 'stream_request_start' }

  // flushText(terminal=false): flush buffered text as a partial or final message.
  // When terminal=true, the message gets stop_reason='end_turn' so Claude Code's
  // oE4() validation passes (it checks that the last assistant message has text content).
  const flushText = (terminal = false): AssistantAPIMessage | null => {
    const text = textBuffer.trim()
    textBuffer = ''
    if (!text) return null
    return buildAssistantTextMessage(messageId, text, !terminal)
  }

  // yieldFinal: yield the last assistant message with stop_reason='end_turn'.
  // Claude Code's queryLoop checks oE4(lastMsg, stop_reason): the last assistant
  // message must have content[last].type === 'text' (not empty content[]).
  // If we have buffered text, flush it as the terminal message.
  // If the buffer is empty (e.g. the turn only had tool calls), synthesise a
  // minimal text message so the content array is non-empty.
  function* yieldFinal(): Generator<AssistantAPIMessage> {
    const text = textBuffer.trim()
    textBuffer = ''
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
        textBuffer += update.content.text
        // Yield incremental text so Claude Code TUI can update in real time
        console.error('[qoder-bridge] Yielding message chunk, textLen=' + update.content.text.length)
        yield buildAssistantTextMessage(messageId, update.content.text, /*partial*/ true)
        continue
      }

      if (update.sessionUpdate === 'tool_call') {
        // Flush any buffered text before the tool call
        const flushed = flushText()
        if (flushed) yield flushed

        // Yield a tool_use assistant message so Claude Code can display it
        yield buildToolUseMessage(update.toolCallId, update.title, update.rawInput)
        continue
      }

      if (update.sessionUpdate === 'tool_call_update') {
        // Qoder handles tool execution internally — we don't re-run tools.
        // Just ignore these; the results will appear in subsequent text chunks.
        continue
      }

      if (update.sessionUpdate === 'agent_finish') {
        yield* yieldFinal()
        console.error('[qoder-bridge] Generator complete (agent_finish)')
        return
      }

      if (update.sessionUpdate === 'agent_error') {
        const flushed = flushText()
        if (flushed) yield flushed
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
      const flushed = flushText()
      if (flushed) yield flushed
      const errMsg: SystemAPIErrorMessage = {
        type: 'system',
        subtype: 'api_error',
        error: acpError,
      }
      yield errMsg
      return
    }

    if (finished) {
      console.error('[qoder-bridge] Generator finishing, textBufferLen=' + textBuffer.length)
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

function buildToolUseMessage(
  toolCallId: string,
  title: string,
  rawInput: unknown,
): AssistantAPIMessage {
  // Parse the tool name from the ACP title (format: "`ToolName`" or "ToolName")
  const toolName = title.replace(/`/g, '').split('(')[0]?.trim() ?? 'UnknownTool'

  return {
    type: 'assistant',
    message: {
      id: `msg_tool_${toolCallId}`,
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolCallId,
          name: toolName,
          input: (rawInput as Record<string, unknown>) ?? {},
        },
      ],
      model: 'qoder',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

