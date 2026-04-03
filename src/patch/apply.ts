/**
 * patch/apply.ts
 *
 * Patches the installed Claude Code bundle to inject acpCallModel as the
 * callModel dependency.
 *
 * How it works:
 *   1. Locates the Claude Code cli.js bundle
 *   2. Finds the productionDeps function (identified by its unique shape)
 *   3. Replaces callModel with a loader that dynamically imports acpCallModel
 *   4. Writes a backup of the original bundle
 *   5. Writes the patched bundle
 *
 * The patch is designed to be:
 *   - Idempotent: running apply twice is safe
 *   - Reversible: run patch/revert.ts to restore the original
 *   - Version-aware: stores the CC version in the backup so revert works
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRODUCTION_DEPS_REGEX = /function\s+([A-Za-z_$][\w$]*)\(\)\{return\{callModel:/g
const SESSION_ID_GETTER_REGEX = /function\s+([A-Za-z_$][\w$]*)\(\)\{return\s+([A-Za-z_$][\w$]*)\.sessionId\}/g
const CWD_GETTER_REGEX = /function\s+([A-Za-z_$][\w$]*)\(\)\{return\s+([A-Za-z_$][\w$]*)\.cwd\}/g

/**
 * The connectivity check function that Claude Code runs before showing the TUI.
 * It tries to reach api.anthropic.com — which will always fail in a Qoder-only
 * setup.  We replace its body with an immediate success return.
 *
 * We replace the full function body rather than re-declaring (JS module scope
 * does not allow duplicate function declarations).
 */
const ERY_ORIGINAL =
  `async function erY(){try{let q=m7(),K=new URL(q.TOKEN_URL),_=[\`\${q.BASE_API_URL}/api/hello\`,\`\${K.origin}/v1/oauth/hello\`],z=async(O)=>{try{let A=await Y1.get(O,{headers:{"User-Agent":lS()}});if(A.status!==200)return{success:!1,error:\`Failed to connect to \${new URL(O).hostname}: Status \${A.status}\`};return{success:!0}}catch(A){let w=new URL(O).hostname,j=Jq6(A);return{success:!1,error:\`Failed to connect to \${w}: \${A instanceof Error?A.code||A.message:String(A)}\`,sslHint:j??void 0}}},$=(await Promise.all(_.map(z))).find((O)=>!O.success);if($)d("tengu_preflight_check_failed",{isConnectivityError:!1,hasErrorMessage:!!$.error,isSSLError:!!$.sslHint});return $||{success:!0}}catch(q){return j6(q),d("tengu_preflight_check_failed",{isConnectivityError:!0}),{success:!1,error:\`Connectivity check error: \${q instanceof Error?q.code||q.message:String(q)}\`}}}`

const ERY_PATCHED =
  `async function erY(){return{success:!0}/*qoder-bridge:connectivity-bypass*/}`

/**
 * PJ() is called ONCE when the _oY Onboarding component mounts (via useState init).
 * _oY mounts BEFORE the user sees the login selection screen (the selection UI is
 * inside Pj6 which is inside _oY's oauth step). So any flag set in onChange fires
 * AFTER PJ() has already been captured — making runtime flag tricks useless.
 *
 * The only reliable approach: check an environment variable set BEFORE claude starts.
 * We expose this as QODER_NO_AUTH=1 claude (or via the wrapper script).
 *
 * We also wire up the login screen "Qoder (no login)" option to exit+restart with
 * the env var set, OR we patch PJ() to return false when QODER_NO_AUTH is set.
 */
const PJ_ORIGINAL =
  `function PJ(){if(D9())return!1;if(process.env.ANTHROPIC_UNIX_SOCKET)return!!process.env.CLAUDE_CODE_OAUTH_TOKEN;let q=Q6(process.env.CLAUDE_CODE_USE_BEDROCK)||Q6(process.env.CLAUDE_CODE_USE_VERTEX)||Q6(process.env.CLAUDE_CODE_USE_FOUNDRY),_=(V7()||{}).apiKeyHelper,z=process.env.ANTHROPIC_AUTH_TOKEN||_||process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR,{source:Y}=Mw({skipRetrievingKeyFromApiKeyHelper:!0}),$=Y==="ANTHROPIC_API_KEY"||Y==="apiKeyHelper";return!(q||z&&!_f8()||$&&!_f8())}`

const PJ_PATCHED =
  `function PJ(){if(process.env.QODER_NO_AUTH)return!1;if(D9())return!1;if(process.env.ANTHROPIC_UNIX_SOCKET)return!!process.env.CLAUDE_CODE_OAUTH_TOKEN;let q=Q6(process.env.CLAUDE_CODE_USE_BEDROCK)||Q6(process.env.CLAUDE_CODE_USE_VERTEX)||Q6(process.env.CLAUDE_CODE_USE_FOUNDRY),_=(V7()||{}).apiKeyHelper,z=process.env.ANTHROPIC_AUTH_TOKEN||_||process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR,{source:Y}=Mw({skipRetrievingKeyFromApiKeyHelper:!0}),$=Y==="ANTHROPIC_API_KEY"||Y==="apiKeyHelper";return!(q||z&&!_f8()||$&&!_f8())}`

/**
 * Login screen patches.
 *
 * We add TWO Qoder options after the existing three, leaving original behaviour
 * completely intact:
 *
 *   1. Claude account (subscription)          — unchanged
 *   2. Anthropic Console (API billing)         — unchanged
 *   3. 3rd-party platform (Bedrock/Vertex/…)  — unchanged
 *   4. Qoder · Use Qoder, login with Anthropic — walks normal OAuth then enters TUI
 *      (callModel is replaced → all AI calls go to Qoder regardless)
 *   5. Qoder · No login required              — sets CLAUDE_CODE_USE_BEDROCK so
 *      PJ() returns false, skips OAuth entirely, enters TUI directly
 */
const LOGIN_OPTIONS_ORIGINAL =
  `[G,Z,{label:Xq.default.createElement(T,null,"3rd-party platform ·"," ",Xq.default.createElement(T,{dimColor:!0},"Amazon Bedrock, Microsoft Foundry, or Vertex AI"),\`\n\`),value:"platform"}]`

const LOGIN_OPTIONS_PATCHED =
  `[G,Z,{label:Xq.default.createElement(T,null,"3rd-party platform ·"," ",Xq.default.createElement(T,{dimColor:!0},"Amazon Bedrock, Microsoft Foundry, or Vertex AI"),\`\n\`),value:"platform"},{label:Xq.default.createElement(T,null,"Qoder (with Anthropic login) ·"," ",Xq.default.createElement(T,{dimColor:!0},"Use Qoder as AI backend, keep Anthropic credentials"),\`\n\`),value:"qoder_auth"},{label:Xq.default.createElement(T,null,"Qoder (no login) ·"," ",Xq.default.createElement(T,{dimColor:!0},"Use Qoder as AI backend, skip all authentication"),\`\n\`),value:"qoder_noauth"}]`

const LOGIN_ONCHANGE_ORIGINAL =
  `onChange:(y)=>{if(y==="platform")d("tengu_oauth_platform_selected",{}),X({state:"platform_setup"});else if(X({state:"ready_to_start"}),y==="claudeai")d("tengu_oauth_claudeai_selected",{}),P(!0);else d("tengu_oauth_console_selected",{}),P(!1)}`

// qoder_noauth: PJ() is captured at _oY mount time (before user sees the login screen),
//   so we cannot change its result from onChange. Instead, re-exec the process with
//   QODER_NO_AUTH=1 so PJ() returns false from the start on the next launch.
//   The config will have been written by then so onboarding won't re-run.
// qoder_auth: walk normal Console OAuth; callModel still routes to Qoder.
// All original branches unchanged.
const LOGIN_ONCHANGE_PATCHED =
  `onChange:(y)=>{if(y==="qoder_noauth"){const{execFileSync:_ef}=require("child_process");const _env={...process.env,QODER_NO_AUTH:"1"};try{_ef(process.execPath,[process.argv[1],...process.argv.slice(2)],{env:_env,stdio:"inherit",detached:false})}catch(_){}process.exit(0);return}if(y==="qoder_auth"){X({state:"ready_to_start"});d("tengu_oauth_console_selected",{});P(!1);return}if(y==="platform")d("tengu_oauth_platform_selected",{}),X({state:"platform_setup"});else if(X({state:"ready_to_start"}),y==="claudeai")d("tengu_oauth_claudeai_selected",{}),P(!0);else d("tengu_oauth_console_selected",{}),P(!1)}`

/**
 * The patched replacement.  We replace the callModel value with a thin
 * wrapper that delegates to acpCallModel from this package.
 *
 * Dynamic import is used so:
 *   - The bridge package doesn't need to be bundled into cli.js
 *   - Hot-reloading the bridge is possible without re-patching
 *
 * We use a synchronous-style generator wrapper to preserve the AsyncGenerator
 * contract expected by queryLoop.
 */
/**
 * Generate the patched function body.
 * The function name must match the original marker (A_q or MDK etc).
 */
export function detectStateAccessors(bundleText: string): {
  sessionIdGetterName?: string
  cwdGetterName?: string
} {
  const sessionIdMatch = [...bundleText.matchAll(SESSION_ID_GETTER_REGEX)][0]
  const cwdMatch = [...bundleText.matchAll(CWD_GETTER_REGEX)][0]
  const result: {
    sessionIdGetterName?: string
    cwdGetterName?: string
  } = {}

  if (sessionIdMatch?.[1]) {
    result.sessionIdGetterName = sessionIdMatch[1]
  }
  if (cwdMatch?.[1]) {
    result.cwdGetterName = cwdMatch[1]
  }

  return result
}

export function generatePatchInjection(
  originalFuncName: string,
  stateAccessors?: { sessionIdGetterName?: string; cwdGetterName?: string },
): string {
  const sessionIdGetterName = stateAccessors?.sessionIdGetterName
  const cwdGetterName = stateAccessors?.cwdGetterName
  const directStateInjection = [
    cwdGetterName
      ? `    if (typeof ${cwdGetterName} === 'function') {
      params.options = { ...params.options, cwd: ${cwdGetterName}() };
    }`
      : '',
    sessionIdGetterName
      ? `    if (typeof ${sessionIdGetterName} === 'function') {
      params.options = { ...params.options, sessionId: ${sessionIdGetterName}() };
    }`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return `
// === QODER-CLAUDE-BRIDGE PATCH START ===
let __qoderCallModel = null;
let __qoderBridgeImported = false;
function __qoderBridgeError(phase, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error('[qoder-bridge] ' + phase + ' failed: ' + message, { cause });
}
function __qoderCliLaunchInitFailure(cause) {
  const message = cause instanceof Error ? cause.name + ': ' + cause.message : String(cause);
  return /(?:\\bqodercli\\b.*(?:spawn|exited|initialize)|spawn .*\\bqodercli\\b|ENOENT|process not running)/i.test(message);
}
async function __loadQoderBridge() {
  if (!__qoderCallModel) {
    try {
      console.error('[qoder-bridge] Loading bridge module...');
      const mod = await import('qoder-claude-bridge');
      __qoderBridgeImported = true;
      if (typeof mod.acpCallModel !== 'function') {
        throw new Error('qoder-claude-bridge export acpCallModel is missing or not a function');
      }
      __qoderCallModel = mod.acpCallModel;
      console.error('[qoder-bridge] Bridge module loaded, acpCallModel=', typeof __qoderCallModel);
    } catch (e) {
      console.error('[qoder-bridge] Bridge startup failed during load/export:', e instanceof Error ? e.message : String(e));
      throw __qoderBridgeError(__qoderBridgeImported ? 'bridge-export' : 'bridge-load', e);
    }
  }
  return __qoderCallModel;
}
async function* __qoderCallModelWrapper(params) {
  console.error('[qoder-bridge] __qoderCallModelWrapper called');
  const fn = await __loadQoderBridge();
  // Inject cwd and sessionId from Claude Code state if available
  try {
${directStateInjection || '    const __qoderNoDirectStateAccessors = true;'}
    if (!params.options?.cwd || !params.options?.sessionId) {
      const stateModule = await import('./entry.js');
      if (!params.options?.cwd && stateModule && typeof stateModule.getCwd === 'function') {
        params.options = { ...params.options, cwd: stateModule.getCwd() };
      }
      if (!params.options?.sessionId && stateModule && typeof stateModule.getSessionId === 'function') {
        params.options = { ...params.options, sessionId: stateModule.getSessionId() };
      }
    }
  } catch (_) { /* state injection is best-effort */ }
  console.error('[qoder-bridge] About to delegate to acpCallModel');
  try {
    for await (const item of fn(params)) {
      console.error('[qoder-bridge] Yielding item type=' + item?.type);
      yield item;
    }
    console.error('[qoder-bridge] acpCallModel iteration completed');
  } catch (e) {
    console.error('[qoder-bridge] acpCallModel error:', e instanceof Error ? e.message : String(e));
    const hint = __qoderCliLaunchInitFailure(e) ? ' — check QODER_CLI_CMD' : '';
    throw new Error('[qoder-bridge] bridge-runtime failed' + hint + ': ' + (e instanceof Error ? e.message : String(e)), { cause: e });
  }
}
function ${originalFuncName}(){return{callModel:__qoderCallModelWrapper,`.trimStart()
}

const PATCH_END_MARKER = '// === QODER-CLAUDE-BRIDGE PATCH END ==='

export type Compatibility =
  | 'compatible'
  | 'compatible_with_warnings'
  | 'already_patched'
  | 'incompatible'

export interface ProbeStatus {
  status: 'compatible' | 'missing' | 'partial' | 'ambiguous'
  reason?: string
}

export interface ProbeResult {
  compatibility: Compatibility
  productionDeps: ProbeStatus & {
    functionName?: string
    matches: number
    marker?: string
  }
  connectivity: ProbeStatus
  authGate: ProbeStatus
  loginUi: ProbeStatus
  stateAccessors: {
    sessionIdGetterName?: string
    cwdGetterName?: string
  }
  reasons: string[]
  warnings: string[]
}

export function probeBundleText(bundleText: string): ProbeResult {
  if (bundleText.includes(PATCH_END_MARKER)) {
    return {
      compatibility: 'already_patched',
        productionDeps: { status: 'compatible', matches: 0 },
        connectivity: { status: 'missing', reason: 'connectivity_probe_missing' },
        authGate: { status: 'missing', reason: 'pj_probe_missing' },
        loginUi: { status: 'missing', reason: 'login_ui_missing' },
        stateAccessors: {},
        reasons: ['already_patched'],
        warnings: [],
      }
  }

  const matches = [...bundleText.matchAll(PRODUCTION_DEPS_REGEX)]
  const firstMatch = matches[0]
  const firstFunctionName = firstMatch?.[1]
  const firstMarker = firstMatch?.[0]
  const productionDeps: ProbeResult['productionDeps'] =
    matches.length === 1 && firstFunctionName && firstMarker
      ? {
          status: 'compatible',
          matches: 1,
          functionName: firstFunctionName,
          marker: firstMarker,
        }
      : matches.length === 0
        ? { status: 'missing', reason: 'production_deps_missing', matches: 0 }
        : { status: 'ambiguous', reason: 'production_deps_ambiguous', matches: matches.length }

  const connectivity: ProbeStatus = bundleText.includes(ERY_ORIGINAL)
    ? { status: 'compatible' }
    : { status: 'missing', reason: 'connectivity_probe_missing' }

  const authGate: ProbeStatus = bundleText.includes(PJ_ORIGINAL)
    ? { status: 'compatible' }
    : { status: 'missing', reason: 'pj_probe_missing' }

  const hasLoginOptions = bundleText.includes(LOGIN_OPTIONS_ORIGINAL)
  const hasLoginOnChange = bundleText.includes(LOGIN_ONCHANGE_ORIGINAL)
  const stateAccessors = detectStateAccessors(bundleText)
  const loginUi: ProbeStatus = hasLoginOptions && hasLoginOnChange
    ? { status: 'compatible' }
    : hasLoginOptions || hasLoginOnChange
      ? { status: 'partial', reason: 'login_ui_partial' }
      : { status: 'missing', reason: 'login_ui_missing' }

  const reasons: string[] = []
  const warnings: string[] = []

  if (productionDeps.status !== 'compatible') {
    reasons.push(productionDeps.reason ?? 'production_deps_missing')
  }
  if (connectivity.reason) warnings.push(connectivity.reason)
  if (authGate.reason) warnings.push(authGate.reason)
  if (loginUi.reason) warnings.push(loginUi.reason)

  const compatibility: Compatibility =
    reasons.length > 0
      ? 'incompatible'
      : warnings.length > 0
        ? 'compatible_with_warnings'
        : 'compatible'

  return {
    compatibility,
    productionDeps,
    connectivity,
    authGate,
    loginUi,
    stateAccessors,
    reasons,
    warnings,
  }
}

export function formatProbeReport(probe: ProbeResult): string {
  const lines = [`Compatibility: ${probe.compatibility}`]
  lines.push(`productionDeps: ${probe.productionDeps.status}${probe.productionDeps.functionName ? ` (${probe.productionDeps.functionName})` : ''}`)
  lines.push(`connectivity: ${probe.connectivity.status}`)
  lines.push(`authGate: ${probe.authGate.status}`)
  lines.push(`loginUi: ${probe.loginUi.status}`)
  if (probe.reasons.length > 0) lines.push(`Reasons: ${probe.reasons.join(', ')}`)
  if (probe.warnings.length > 0) lines.push(`Warnings: ${probe.warnings.join(', ')}`)
  return lines.join('\n')
}

export function applyPatchText(original: string): { patched: string; probe: ProbeResult } {
  const probe = probeBundleText(original)
  if (probe.compatibility === 'incompatible') {
    throw new Error(formatProbeReport(probe))
  }
  if (probe.compatibility === 'already_patched') {
    return { patched: original, probe }
  }

  let patched = original
  if (probe.connectivity.status === 'compatible') {
    patched = patched.replace(ERY_ORIGINAL, escapeReplacement(ERY_PATCHED))
  }
  if (probe.authGate.status === 'compatible') {
    patched = patched.replace(PJ_ORIGINAL, escapeReplacement(PJ_PATCHED))
  }
  if (probe.loginUi.status === 'compatible') {
    patched = patched.replace(LOGIN_OPTIONS_ORIGINAL, escapeReplacement(LOGIN_OPTIONS_PATCHED))
    patched = patched.replace(LOGIN_ONCHANGE_ORIGINAL, escapeReplacement(LOGIN_ONCHANGE_PATCHED))
  }

  const marker = probe.productionDeps.marker
  const functionName = probe.productionDeps.functionName
  if (!marker || !functionName) {
    throw new Error(formatProbeReport(probe))
  }

  const patchInjection = generatePatchInjection(functionName, probe.stateAccessors)
  patched = patched.replace(marker, patchInjection) + '\n' + PATCH_END_MARKER
  return { patched, probe }
}

// ---------------------------------------------------------------------------
// Locate Claude Code bundle
// ---------------------------------------------------------------------------

function findClaudeCodeBundle(): string {
  // Try well-known paths
  const candidates = [
    // npm global install
    resolve(process.env['npm_config_prefix'] ?? '', 'lib/node_modules/@ali/claude-code/cli.js'),
    resolve(process.env['HOME'] ?? '', '.npm-global/lib/node_modules/@ali/claude-code/cli.js'),
    resolve('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    resolve('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    // via `which claude`
    ...resolveFromWhich(),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      console.log(`Found Claude Code bundle: ${candidate}`)
      return candidate
    }
  }

  throw new Error(
    'Could not locate Claude Code bundle.\n' +
    'Set CLAUDE_CODE_BUNDLE env var to the path of cli.js, or install Claude Code globally.',
  )
}

function resolveFromWhich(): string[] {
  try {
    const which = execSync('which claude', { encoding: 'utf-8' }).trim()
    if (!which) return []
    // which returns the symlink — resolve to the actual file
    const real = execSync(`readlink -f "${which}"`, { encoding: 'utf-8' }).trim()
    const dir = dirname(real)
    return [
      resolve(dir, 'cli.js'),
      resolve(dir, '../cli.js'),
    ]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Patch logic
// ---------------------------------------------------------------------------

/**
 * Escape $ characters in replacement strings for String.prototype.replace().
 * In JS replace(), $ has special meaning (e.g., $&, $`, $', $$).
 * Use $$ to represent a literal $.
 */
function escapeReplacement(str: string): string {
  return str.replace(/\$/g, '$$$$')
}

export function applyPatch(bundlePath: string): void {
  const original = readFileSync(bundlePath, 'utf-8')

  const probe = probeBundleText(original)
  if (probe.compatibility === 'already_patched') {
    console.log('Bundle is already patched — nothing to do.')
    return
  }
  if (probe.compatibility === 'incompatible') {
    throw new Error(formatProbeReport(probe))
  }

  const backupPath = bundlePath + '.qoder-bridge.bak'
  if (existsSync(backupPath)) {
    const backup = readFileSync(backupPath, 'utf-8')
    if (backup.includes(PATCH_END_MARKER)) {
      throw new Error('Existing backup appears patched: backup_looks_patched')
    }
    console.log(`Backup already exists: ${backupPath}`)
  } else {
    copyFileSync(bundlePath, backupPath)
    console.log(`Backup written: ${backupPath}`)
  }

  const { patched, probe: applyProbe } = applyPatchText(original)

  if (applyProbe.connectivity.status === 'compatible') {
    console.log('Patched erY() connectivity check.')
  } else {
    console.warn('WARNING: Could not find erY() connectivity check — interactive mode may show a network error.')
  }

  if (applyProbe.authGate.status === 'compatible') {
    console.log('Patched PJ() to respect QODER_NO_AUTH env var.')
  } else {
    console.warn('WARNING: Could not find PJ() — QODER_NO_AUTH bypass may not work.')
  }

  if (applyProbe.loginUi.status === 'compatible') {
    console.log('Patched login screen and onChange handler.')
  } else if (applyProbe.loginUi.status === 'partial') {
    console.warn('WARNING: Login UI patch skipped because only part of the expected structure was found.')
  } else {
    console.warn('WARNING: Could not find login UI structures — Qoder login option not added.')
  }

  writeFileSync(bundlePath, patched, 'utf-8')
  console.log(`\nPatch applied successfully to: ${bundlePath}`)
  console.log('Claude Code will now route model calls through Qoder.')
  console.log('\nTo undo: node dist/patch/revert.js')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(): void {
  const args = new Set(process.argv.slice(2))
  const bundlePath = process.env['CLAUDE_CODE_BUNDLE'] ?? findClaudeCodeBundle()
  if (args.has('--check-only')) {
    const probe = probeBundleText(readFileSync(bundlePath, 'utf-8'))
    if (args.has('--json')) {
      console.log(JSON.stringify(probe, null, 2))
    } else {
      console.log(formatProbeReport(probe))
    }
    process.exit(probe.compatibility === 'incompatible' ? 1 : 0)
  }
  applyPatch(bundlePath)
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  main()
}
