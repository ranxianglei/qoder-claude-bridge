/**
 * Minimal local type definitions that mirror Claude Code's internal types
 * as needed by the Bridge.  These are NOT imported from Claude Code itself —
 * that would create a hard compile-time dependency on internal paths that
 * change across versions.  Instead we define structural equivalents and rely
 * on TypeScript's structural typing for compatibility at the patch site.
 */

import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'

// ---------------------------------------------------------------------------
// SystemPrompt  (src/utils/systemPromptType.ts)
// ---------------------------------------------------------------------------

/** Claude Code uses a branded readonly string array as system prompt. */
export type SystemPrompt = readonly string[]

// ---------------------------------------------------------------------------
// Message  (src/types/message.ts — not present in decompiled source as a file,
//            only as virtual .js import inside bundles)
//
// In practice callModel receives Message[] where Message is one of:
//   UserMessage | AssistantMessage | SystemMessage | ...
// We only need to extract content from UserMessage to build ACP prompts.
// ---------------------------------------------------------------------------

export interface UserMessage {
  type: 'user'
  message: BetaMessageParam & { role: 'user' }
  uuid?: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: { role: 'assistant'; content: BetaContentBlockParam[] }
  uuid?: string
}

export interface SystemMessage {
  type: 'system'
  content: string
}

export type Message = UserMessage | AssistantMessage | SystemMessage | { type: string }

// ---------------------------------------------------------------------------
// StreamEvent / SDKMessage  (what queryModelWithStreaming yields)
// ---------------------------------------------------------------------------

/** Minimal BetaMessage structure needed to construct our yield values. */
export interface MinimalBetaMessage {
  id: string
  type: 'message'
  role: 'assistant'
  content: BetaContentBlockParam[]
  model: string
  stop_reason: string | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * StreamEvent — emitted during streaming to surface progress information to
 * Claude Code's TUI.  We emit a minimal subset.
 */
export interface RequestStartEvent {
  type: 'request_start'
  requestId: string
  startTime: number
}

export interface StreamEvent {
  type: 'stream_event'
  event: {
    type: string
    [key: string]: unknown
  }
}

export interface SystemAPIErrorMessage {
  type: 'system'
  subtype: 'api_error'
  error: Error
}

/** AssistantMessage as yielded from queryModelWithStreaming. */
export interface AssistantAPIMessage {
  type: 'assistant'
  message: MinimalBetaMessage
  uuid?: string
}

/** The union type returned by queryModelWithStreaming / callModel. */
export type CallModelYield =
  | { type: 'stream_request_start' }
  | RequestStartEvent
  | StreamEvent
  | AssistantAPIMessage
  | SystemAPIErrorMessage

// ---------------------------------------------------------------------------
// Tools / Options  (passed into callModel — we pass-through unchanged)
// ---------------------------------------------------------------------------

export type Tools = BetaToolUnion[]

export interface ThinkingConfig {
  type: 'disabled' | 'enabled' | 'adaptive'
  budgetTokens?: number
}

/** Minimal Options fields we actually inspect inside acpCallModel. */
export interface CallModelOptions {
  model: string
  isNonInteractiveSession?: boolean
  [key: string]: unknown
}
