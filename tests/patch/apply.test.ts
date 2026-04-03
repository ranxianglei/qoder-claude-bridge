import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPatch,
  applyPatchText,
  detectStateAccessors,
  formatProbeReport,
  generatePatchInjection,
  probeBundleText,
} from '../../src/patch/apply.js'

const connectivityOriginal = 'async function erY(){try{let q=m7(),K=new URL(q.TOKEN_URL),_=[`${q.BASE_API_URL}/api/hello`,`${K.origin}/v1/oauth/hello`],z=async(O)=>{try{let A=await Y1.get(O,{headers:{"User-Agent":lS()}});if(A.status!==200)return{success:!1,error:`Failed to connect to ${new URL(O).hostname}: Status ${A.status}`};return{success:!0}}catch(A){let w=new URL(O).hostname,j=Jq6(A);return{success:!1,error:`Failed to connect to ${w}: ${A instanceof Error?A.code||A.message:String(A)}`,sslHint:j??void 0}}},$=(await Promise.all(_.map(z))).find((O)=>!O.success);if($)d("tengu_preflight_check_failed",{isConnectivityError:!1,hasErrorMessage:!!$.error,isSSLError:!!$.sslHint});return $||{success:!0}}catch(q){return j6(q),d("tengu_preflight_check_failed",{isConnectivityError:!0}),{success:!1,error:`Connectivity check error: ${q instanceof Error?q.code||q.message:String(q)}`}}}'
const pjOriginal = 'function PJ(){if(D9())return!1;if(process.env.ANTHROPIC_UNIX_SOCKET)return!!process.env.CLAUDE_CODE_OAUTH_TOKEN;let q=Q6(process.env.CLAUDE_CODE_USE_BEDROCK)||Q6(process.env.CLAUDE_CODE_USE_VERTEX)||Q6(process.env.CLAUDE_CODE_USE_FOUNDRY),_=(V7()||{}).apiKeyHelper,z=process.env.ANTHROPIC_AUTH_TOKEN||_||process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR,{source:Y}=Mw({skipRetrievingKeyFromApiKeyHelper:!0}),$=Y==="ANTHROPIC_API_KEY"||Y==="apiKeyHelper";return!(q||z&&!_f8()||$&&!_f8())}'
const loginOptionsOriginal = '[G,Z,{label:Xq.default.createElement(T,null,"3rd-party platform ·"," ",Xq.default.createElement(T,{dimColor:!0},"Amazon Bedrock, Microsoft Foundry, or Vertex AI"),`\n`),value:"platform"}]'
const loginOnChangeOriginal = 'onChange:(y)=>{if(y==="platform")d("tengu_oauth_platform_selected",{}),X({state:"platform_setup"});else if(X({state:"ready_to_start"}),y==="claudeai")d("tengu_oauth_claudeai_selected",{}),P(!0);else d("tengu_oauth_console_selected",{}),P(!1)}'

function makeBundle(functionName = 'A_q', options?: {
  connectivity?: boolean
  authGate?: boolean
  loginOptions?: boolean
  loginOnChange?: boolean
  duplicateProductionDeps?: boolean
  patched?: boolean
}): string {
  const parts = [
    options?.connectivity === false ? '' : connectivityOriginal,
    options?.authGate === false ? '' : pjOriginal,
    options?.loginOptions === false ? '' : loginOptionsOriginal,
    options?.loginOnChange === false ? '' : loginOnChangeOriginal,
    `function ${functionName}(){return{callModel:orig,microcompact:m,autocompact:a,uuid:u}}`,
    options?.duplicateProductionDeps ? 'function Z9(){return{callModel:other,microcompact:m,autocompact:a,uuid:u}}' : '',
    options?.patched ? '\n// === QODER-CLAUDE-BRIDGE PATCH END ===' : '',
  ]
  return parts.join('\n')
}

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('generatePatchInjection', () => {
  it('separates startup phases and keeps bridge injection details', () => {
    const wrapper = generatePatchInjection('A_q', {
      cwdGetterName: 'ob',
      sessionIdGetterName: 'k8',
    })
    const [loadSection, runtimeSection = ''] = wrapper.split('async function* __qoderCallModelWrapper')

    expect(wrapper).toContain("__qoderBridgeImported ? 'bridge-export' : 'bridge-load'")
    expect(wrapper).toContain("new Error('[qoder-bridge] ' + phase + ' failed: ' + message, { cause })")
    expect(wrapper).toContain('bridge-runtime failed')
    expect(runtimeSection).toContain('QODER_CLI_CMD')
    expect(loadSection).not.toContain('QODER_CLI_CMD')
    expect(wrapper).not.toContain('Bridge not available — check QODER_CLI_CMD')
    expect(wrapper).toContain('cwd: ob()')
    expect(wrapper).toContain('sessionId: k8()')
    expect(wrapper).toContain("import('./entry.js')")
    expect(wrapper).toContain('function A_q(){return{callModel:__qoderCallModelWrapper,')
  })

  it('preserves the original productionDeps function name in the injected wrapper', () => {
    const wrapper = generatePatchInjection('RenamedDeps')
    expect(wrapper).toContain('function RenamedDeps(){return{callModel:__qoderCallModelWrapper,')
  })
})

describe('probeBundleText', () => {
  it('detects direct state accessor functions in the bundle', () => {
    const bundle = [
      'function k8(){return f8.sessionId}',
      'function ob(){return f8.cwd}',
      makeBundle('A_q', {
        connectivity: false,
        authGate: false,
        loginOptions: false,
        loginOnChange: false,
      }),
    ].join('\n')

    expect(detectStateAccessors(bundle)).toEqual({
      sessionIdGetterName: 'k8',
      cwdGetterName: 'ob',
    })
  })

  it('accepts renamed but structurally compatible productionDeps', () => {
    const probe = probeBundleText(makeBundle('RenamedDeps', {
      connectivity: false,
      authGate: false,
      loginOptions: false,
      loginOnChange: false,
    }))

    expect(probe.compatibility).toBe('compatible_with_warnings')
    expect(probe.productionDeps.status).toBe('compatible')
    expect(probe.productionDeps.functionName).toBe('RenamedDeps')
    expect(probe.stateAccessors).toEqual({})
    expect(probe.warnings).toContain('connectivity_probe_missing')
    expect(probe.warnings).toContain('pj_probe_missing')
    expect(probe.warnings).toContain('login_ui_missing')
  })

  it('fails when productionDeps is missing', () => {
    const probe = probeBundleText('function nothing(){return{}}')
    expect(probe.compatibility).toBe('incompatible')
    expect(probe.reasons).toContain('production_deps_missing')
  })

  it('fails when productionDeps is ambiguous', () => {
    const probe = probeBundleText(makeBundle('A_q', { duplicateProductionDeps: true }))
    expect(probe.compatibility).toBe('incompatible')
    expect(probe.reasons).toContain('production_deps_ambiguous')
  })

  it('reports partial login UI capability without blocking core patching', () => {
    const probe = probeBundleText(makeBundle('A_q', { loginOnChange: false }))
    expect(probe.compatibility).toBe('compatible_with_warnings')
    expect(probe.loginUi.status).toBe('partial')
    expect(probe.warnings).toContain('login_ui_partial')
  })

  it('detects already patched bundles as idempotent', () => {
    const probe = probeBundleText(makeBundle('A_q', { patched: true }))
    expect(probe.compatibility).toBe('already_patched')
    expect(probe.reasons).toContain('already_patched')
  })

  it('formats probe reports with explicit reason codes', () => {
    const report = formatProbeReport(probeBundleText(makeBundle('A_q', { loginOnChange: false })))
    expect(report).toContain('Compatibility: compatible_with_warnings')
    expect(report).toContain('Warnings:')
    expect(report).toContain('login_ui_partial')
  })
})

describe('applyPatchText', () => {
  it('injects wrapper using the detected productionDeps function name', () => {
    const bundle = [
      'function k8(){return f8.sessionId}',
      'function ob(){return f8.cwd}',
      makeBundle('Q9', {
        connectivity: false,
        authGate: false,
        loginOptions: false,
        loginOnChange: false,
      }),
    ].join('\n')
    const { patched } = applyPatchText(bundle)

    expect(patched).toContain('function Q9(){return{callModel:__qoderCallModelWrapper,')
    expect(patched).toContain('sessionId: k8()')
    expect(patched).toContain('cwd: ob()')
    expect(patched).toContain('// === QODER-CLAUDE-BRIDGE PATCH END ===')
  })

  it('skips partial login UI patching instead of half-applying it', () => {
    const original = makeBundle('A_q', { loginOnChange: false })
    const { patched } = applyPatchText(original)
    expect(patched).toContain(loginOptionsOriginal)
    expect(patched).not.toContain('qoder_noauth')
  })
})

describe('applyPatch file safety', () => {
  it('does not create files when the bundle is incompatible', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qoder-patch-test-'))
    const bundlePath = join(tempDir, 'cli.js')
    writeFileSync(bundlePath, 'function nothing(){return{}}', 'utf-8')

    expect(() => applyPatch(bundlePath)).toThrow('production_deps_missing')
    expect(readFileSync(bundlePath, 'utf-8')).toBe('function nothing(){return{}}')
    expect(() => readFileSync(bundlePath + '.qoder-bridge.bak', 'utf-8')).toThrow()
  })

  it('refuses to use a patched backup', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qoder-patch-test-'))
    const bundlePath = join(tempDir, 'cli.js')
    writeFileSync(bundlePath, makeBundle('A_q'), 'utf-8')
    writeFileSync(bundlePath + '.qoder-bridge.bak', makeBundle('A_q', { patched: true }), 'utf-8')

    expect(() => applyPatch(bundlePath)).toThrow('backup_looks_patched')
  })

  it('creates a backup with the original bytes before patching', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qoder-patch-test-'))
    const bundlePath = join(tempDir, 'cli.js')
    const original = makeBundle('A_q')
    writeFileSync(bundlePath, original, 'utf-8')

    applyPatch(bundlePath)

    expect(readFileSync(bundlePath + '.qoder-bridge.bak', 'utf-8')).toBe(original)
    expect(readFileSync(bundlePath, 'utf-8')).toContain('// === QODER-CLAUDE-BRIDGE PATCH END ===')
  })

  it('is idempotent when reapplying to an already patched bundle', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qoder-patch-test-'))
    const bundlePath = join(tempDir, 'cli.js')
    const original = makeBundle('A_q')
    writeFileSync(bundlePath, original, 'utf-8')

    applyPatch(bundlePath)
    const firstPatched = readFileSync(bundlePath, 'utf-8')
    applyPatch(bundlePath)

    expect(readFileSync(bundlePath, 'utf-8')).toBe(firstPatched)
    expect(readFileSync(bundlePath + '.qoder-bridge.bak', 'utf-8')).toBe(original)
  })

  it('reuses an existing clean backup without overwriting it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'qoder-patch-test-'))
    const bundlePath = join(tempDir, 'cli.js')
    const backupDir = join(tempDir, 'nested')
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(bundlePath, makeBundle('A_q'), 'utf-8')
    writeFileSync(bundlePath + '.qoder-bridge.bak', 'clean backup', 'utf-8')

    applyPatch(bundlePath)

    expect(readFileSync(bundlePath + '.qoder-bridge.bak', 'utf-8')).toBe('clean backup')
  })
})
