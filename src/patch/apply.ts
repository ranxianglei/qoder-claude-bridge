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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The exact string in the bundle that identifies the productionDeps function.
 * Note: This marker changes between Claude Code versions (minified names).
 * v2.1.88:  function A_q(){return{callModel:
 * v2.1.89:  function MDK(){return{callModel:
 */
const PRODUCTION_DEPS_MARKERS = [
  'function A_q(){return{callModel:',
  'function MDK(){return{callModel:',
]

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
function generatePatchInjection(originalFuncName: string): string {
  return `
// === QODER-CLAUDE-BRIDGE PATCH START ===
let __qoderCallModel = null;
async function __loadQoderBridge() {
  if (!__qoderCallModel) {
    try {
      console.error('[qoder-bridge] Loading bridge module...');
      const mod = await import('qoder-claude-bridge');
      __qoderCallModel = mod.acpCallModel;
      console.error('[qoder-bridge] Bridge module loaded, acpCallModel=', typeof __qoderCallModel);
    } catch (e) {
      console.error('[qoder-bridge] Failed to load bridge:', e.message);
      __qoderCallModel = null;
    }
  }
  return __qoderCallModel;
}
async function* __qoderCallModelWrapper(params) {
  console.error('[qoder-bridge] __qoderCallModelWrapper called');
  const fn = await __loadQoderBridge();
  if (!fn) {
    console.error('[qoder-bridge] Bridge not available');
    throw new Error('[qoder-bridge] Bridge not available — check QODER_CLI_CMD');
  }
  // Inject cwd and sessionId from Claude Code state if available
  try {
    const stateModule = await import('./entry.js');
    if (stateModule && typeof stateModule.getCwd === 'function') {
      params.options = { ...params.options, cwd: stateModule.getCwd() };
    }
    if (stateModule && typeof stateModule.getSessionId === 'function') {
      params.options = { ...params.options, sessionId: stateModule.getSessionId() };
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
    console.error('[qoder-bridge] acpCallModel error:', e.message);
    throw e;
  }
}
function ${originalFuncName}(){return{callModel:__qoderCallModelWrapper,`.trimStart()
}

const PATCH_END_MARKER = '// === QODER-CLAUDE-BRIDGE PATCH END ==='

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

function applyPatch(bundlePath: string): void {
  const original = readFileSync(bundlePath, 'utf-8')

  // Check if already patched
  if (original.includes(PATCH_END_MARKER)) {
    console.log('Bundle is already patched — nothing to do.')
    return
  }

  // Find which marker matches this bundle version
  let matchedMarker: string | null = null
  let originalFuncName: string | null = null
  for (const marker of PRODUCTION_DEPS_MARKERS) {
    if (original.includes(marker)) {
      matchedMarker = marker
      // Extract function name from marker: "function Xxx(){return{callModel:"
      const match = marker.match(/function (\w+)\(\)/)
      originalFuncName = match?.[1] ?? null
      break
    }
  }

  if (!matchedMarker || !originalFuncName) {
    throw new Error(
      `Could not find productionDeps marker in bundle.\n` +
      `Tried: ${JSON.stringify(PRODUCTION_DEPS_MARKERS)}\n` +
      `The Claude Code version may have changed. ` +
      `Check DESIGN.md for guidance on updating the patch.`,
    )
  }

  console.log(`Detected marker: ${matchedMarker}`)

  // Backup original
  const backupPath = bundlePath + '.qoder-bridge.bak'
  if (!existsSync(backupPath)) {
    copyFileSync(bundlePath, backupPath)
    console.log(`Backup written: ${backupPath}`)
  } else {
    console.log(`Backup already exists: ${backupPath}`)
  }

  // Build patched content:
  // (1) replace erY() connectivity check — bypass api.anthropic.com ping
  // (2) patch PJ() to check QODER_NO_AUTH env var
  // (3) add Qoder login options and onChange handler
  // (4) inject callModel wrapper (productionDeps)
  let patched = original
  if (patched.includes(ERY_ORIGINAL)) {
    patched = patched.replace(ERY_ORIGINAL, escapeReplacement(ERY_PATCHED))
    console.log('Patched erY() connectivity check.')
  } else {
    console.warn('WARNING: Could not find erY() connectivity check — interactive mode may show a network error.')
  }

  if (patched.includes(PJ_ORIGINAL)) {
    patched = patched.replace(PJ_ORIGINAL, escapeReplacement(PJ_PATCHED))
    console.log('Patched PJ() to respect QODER_NO_AUTH env var.')
  } else {
    console.warn('WARNING: Could not find PJ() — QODER_NO_AUTH bypass may not work.')
  }

  if (patched.includes(LOGIN_OPTIONS_ORIGINAL)) {
    patched = patched.replace(LOGIN_OPTIONS_ORIGINAL, escapeReplacement(LOGIN_OPTIONS_PATCHED))
    console.log('Patched login screen: added Qoder option.')
  } else {
    console.warn('WARNING: Could not find login options array — Qoder login option not added.')
  }

  if (patched.includes(LOGIN_ONCHANGE_ORIGINAL)) {
    patched = patched.replace(LOGIN_ONCHANGE_ORIGINAL, escapeReplacement(LOGIN_ONCHANGE_PATCHED))
    console.log('Patched login onChange: Qoder selection skips auth.')
  } else {
    console.warn('WARNING: Could not find login onChange handler — Qoder selection may not work.')
  }

  const patchInjection = generatePatchInjection(originalFuncName)
  patched = patched.replace(matchedMarker, patchInjection) + '\n' + PATCH_END_MARKER

  writeFileSync(bundlePath, patched, 'utf-8')
  console.log(`\nPatch applied successfully to: ${bundlePath}`)
  console.log('Claude Code will now route model calls through Qoder.')
  console.log('\nTo undo: node dist/patch/revert.js')
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const bundlePath = process.env['CLAUDE_CODE_BUNDLE'] ?? findClaudeCodeBundle()
applyPatch(bundlePath)
