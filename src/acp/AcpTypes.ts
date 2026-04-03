/**
 * ACP (Agent Client Protocol) — Qoder's JSON-RPC 2.0 over stdio protocol.
 * Protocol is newline-delimited JSON (NDJSON): one JSON object per line on stdout/stdin.
 *
 * Three message categories (distinguished by presence of id/method fields):
 *   1. id + method  → Qoder is requesting something from us (e.g. permission)
 *   2. id, no method → Response to a request we sent
 *   3. no id + method → Notification (streaming update)
 */

// ---------------------------------------------------------------------------
// Wire-level JSON-RPC types
// ---------------------------------------------------------------------------

export interface AcpRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface AcpResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: AcpError
}

export interface AcpNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface AcpError {
  code: number
  message: string
  data?: unknown
}

export type AcpMessage = AcpRequest | AcpResponse | AcpNotification

// ---------------------------------------------------------------------------
// ACP method params / results
// ---------------------------------------------------------------------------

export interface AcpInitializeParams {
  protocolVersion: number
  clientCapabilities: Record<string, unknown>
}

export interface AcpInitializeResult {
  agentCapabilities: Record<string, unknown>
}

export interface AcpSessionNewParams {
  cwd: string
}

export interface AcpSessionNewResult {
  sessionId: string
}

export interface AcpSessionLoadParams {
  sessionId: string
  cwd: string
}

export interface AcpSessionCancelParams {
  sessionId: string
}

export interface AcpSessionSetModelParams {
  sessionId: string
  modelId: string
}

export interface AcpSessionSetModeParams {
  sessionId: string
  modeId: string
}

// ---------------------------------------------------------------------------
// Prompt content (multimodal)
// ---------------------------------------------------------------------------

export type AcpPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string } // base64-encoded

export interface AcpSessionPromptParams {
  sessionId: string
  cwd: string
  prompt: AcpPromptContent[]
}

// ---------------------------------------------------------------------------
// Streaming update notifications (method: "session/update")
// ---------------------------------------------------------------------------

export type AcpUpdateType =
  | 'agent_thought_chunk'
  | 'agent_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'agent_error'
  | 'agent_finish'

export interface AcpUpdateBase {
  sessionUpdate: AcpUpdateType
}

export interface AcpThoughtChunkUpdate extends AcpUpdateBase {
  sessionUpdate: 'agent_thought_chunk'
  content: { type: 'text'; text: string }
}

export interface AcpMessageChunkUpdate extends AcpUpdateBase {
  sessionUpdate: 'agent_message_chunk'
  content: { type: 'text'; text: string }
}

export interface AcpToolCallUpdate extends AcpUpdateBase {
  sessionUpdate: 'tool_call'
  toolCallId: string
  title: unknown
  rawInput: unknown
  kind: string
}

export interface AcpToolCallResultUpdate extends AcpUpdateBase {
  sessionUpdate: 'tool_call_update'
  toolCallId: string
  status?: string
  title?: unknown
  kind?: string
  rawOutput?: unknown
  content?: unknown
  locations?: unknown
  _meta?: Record<string, unknown>
}

export interface AcpAgentErrorUpdate extends AcpUpdateBase {
  sessionUpdate: 'agent_error'
  error?: string
}

export interface AcpAgentFinishUpdate extends AcpUpdateBase {
  sessionUpdate: 'agent_finish'
}

export type AcpUpdate =
  | AcpThoughtChunkUpdate
  | AcpMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpToolCallResultUpdate
  | AcpAgentErrorUpdate
  | AcpAgentFinishUpdate

// ---------------------------------------------------------------------------
// Permission request (Qoder → client, has both id and method)
// ---------------------------------------------------------------------------

export interface AcpPermissionRequestParams {
  toolCall: { title: string }
  _meta?: { 'ai-coding/tool-name'?: string }
}

export interface AcpPermissionOutcome {
  outcome: 'selected'
  optionId: 'allow_always' | 'allow_once' | 'deny'
}

export interface AcpPermissionResult {
  outcome: AcpPermissionOutcome
}
