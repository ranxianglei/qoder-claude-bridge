import type { AcpPromptContent } from '../acp/AcpTypes.js'
import type { Message, SystemPrompt, UserMessage } from '../types/claudeCode.js'
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'

// ---------------------------------------------------------------------------
// cwd extraction
// ---------------------------------------------------------------------------

/**
 * Extract the current working directory from Claude Code's system prompt.
 *
 * Claude Code injects the following block into every API call's system prompt:
 *   "Here is useful information about the environment you are running in:\n
 *    <env>\nWorking directory: /path/to/project\n..."
 *
 * This is a reliable fallback if STATE.cwd is not directly available.
 */
export function extractCwdFromSystemPrompt(systemPrompt: SystemPrompt | string | undefined): string | undefined {
  if (!systemPrompt) return undefined

  const text = Array.isArray(systemPrompt)
    ? (systemPrompt as readonly string[]).join('\n')
    : (systemPrompt as string)

  const match = text.match(/Working directory:\s*(\S+)/i)
  return match?.[1]
}

// ---------------------------------------------------------------------------
// Message → ACP prompt conversion
// ---------------------------------------------------------------------------

/**
 * Convert Claude Code's internal message array and system prompt into the
 * flat AcpPromptContent[] array expected by ACP session/prompt.
 *
 * Design decisions (mirroring qoderclaw analysis):
 *  1. Only the LAST user message is forwarded — Qoder maintains conversation
 *     history internally via ACP sessions.  Replaying history would duplicate
 *     context and confuse Qoder's state machine.
 *  2. The system prompt is prepended as a text block only when it contains
 *     meaningful content (e.g. custom instructions).  Claude Code's boilerplate
 *     env block is stripped to avoid sending redundant cwd / platform info.
 *  3. Anthropic image format (base64 source) is mapped to ACP image format.
 */
export function messagesToAcpPrompt(
  messages: Message[],
  systemPrompt?: SystemPrompt,
): AcpPromptContent[] {
  const result: AcpPromptContent[] = []

  // --- System prompt prefix (custom instructions only) ---
  const systemText = extractCustomSystemInstructions(systemPrompt)
  if (systemText) {
    result.push({ type: 'text', text: systemText })
  }

  // --- Last user message ---
  const lastUser = findLastUserMessage(messages)
  if (!lastUser) return result

  const userContent = normalizeUserContent(lastUser.message.content)
  for (const block of userContent) {
    const converted = convertContentBlock(block)
    if (converted) result.push(converted)
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findLastUserMessage(messages: Message[]): UserMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.type === 'user') return msg as UserMessage
  }
  return undefined
}

/**
 * Claude Code's system prompt is a readonly string[].  Each element is a
 * "section" of the system prompt.  We want to surface only the user-defined
 * custom instructions, not the boilerplate env block Claude Code injects.
 *
 * Heuristic: skip sections that match well-known boilerplate markers.
 */
function extractCustomSystemInstructions(systemPrompt: SystemPrompt | undefined): string | undefined {
  if (!systemPrompt || systemPrompt.length === 0) return undefined

  const BOILERPLATE_MARKERS = [
    'Here is useful information about the environment',
    'Working directory:',
    '<env>',
  ]

  const custom = (systemPrompt as readonly string[])
    .filter((section) => {
      const lower = section.toLowerCase()
      return !BOILERPLATE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))
    })
    .join('\n\n')
    .trim()

  return custom || undefined
}

/**
 * user message content can be either a string or an array of content blocks.
 */
function normalizeUserContent(
  content: string | BetaContentBlockParam | BetaContentBlockParam[],
): BetaContentBlockParam[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

function convertContentBlock(block: BetaContentBlockParam): AcpPromptContent | null {
  if (block.type === 'text') {
    const text = (block as { type: 'text'; text: string }).text
    if (!text) return null
    return { type: 'text', text }
  }

  if (block.type === 'image') {
    const img = block as BetaImageBlockParam
    if (img.source.type === 'base64') {
      return {
        type: 'image',
        mimeType: img.source.media_type,
        data: img.source.data,
      }
    }
    // URL-type images: skip (ACP only supports base64)
    return null
  }

  // tool_use, tool_result, document, etc. — not forwarded to Qoder
  return null
}
