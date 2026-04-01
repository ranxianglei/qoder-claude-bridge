import { z } from 'zod'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  /** Path to qodercli executable */
  qoderCliCmd: z.string().default('qodercli'),

  /** Default working directory when cwd cannot be determined */
  defaultWorkdir: z.string().default(homedir()),

  /** Session idle timeout in milliseconds before cleanup (default 30 min) */
  sessionIdleMs: z.coerce.number().int().positive().default(1_800_000),

  /** Whether to auto-approve all Qoder tool-call permission requests */
  autoApproveTools: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  /** Path to the session persistence file */
  sessionStore: z
    .string()
    .default(join(homedir(), '.qoder-bridge', 'sessions.json')),

  /** Log level */
  logLevel: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),

  /** Default Qoder model when none is specified */
  modelDefault: z.string().default('auto'),
})

export type Config = z.infer<typeof ConfigSchema>

// ---------------------------------------------------------------------------
// Model ID mapping  (Claude Code model param → Qoder model ID)
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  qoder: 'auto',
  'qoder-auto': 'auto',
  'qoder-lite': 'lite',
  'qoder-efficient': 'efficient',
  'qoder-performance': 'performance',
  'qoder-ultimate': 'ultimate',
}

/** Map a Claude Code model string to a Qoder model ID. Defaults to 'auto'. */
export function toQoderModel(claudeModel: string | undefined, fallback: string): string {
  if (!claudeModel) return fallback
  return MODEL_MAP[claudeModel] ?? fallback
}

// ---------------------------------------------------------------------------
// Loader — reads from process.env (dotenv loading is caller's responsibility)
// ---------------------------------------------------------------------------

let _config: Config | null = null

export function loadConfig(): Config {
  if (_config) return _config
  _config = ConfigSchema.parse({
    qoderCliCmd: process.env['QODER_CLI_CMD'],
    defaultWorkdir: process.env['QODER_DEFAULT_WORKDIR'],
    sessionIdleMs: process.env['QODER_SESSION_IDLE_MS'],
    autoApproveTools: process.env['QODER_AUTO_APPROVE_TOOLS'],
    sessionStore: process.env['QODER_SESSION_STORE'],
    logLevel: process.env['QODER_LOG_LEVEL'],
    modelDefault: process.env['QODER_MODEL_DEFAULT'],
  })
  return _config
}

/** Reset cached config (useful in tests). */
export function resetConfig(): void {
  _config = null
}
