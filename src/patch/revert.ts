/**
 * patch/revert.ts — Restore the original Claude Code bundle from backup.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { execSync } from 'child_process'

const PATCH_END_MARKER = '// === QODER-CLAUDE-BRIDGE PATCH END ==='

function findClaudeCodeBundle(): string {
  const candidates = [
    resolve(process.env['npm_config_prefix'] ?? '', 'lib/node_modules/@ali/claude-code/cli.js'),
    resolve(process.env['HOME'] ?? '', '.npm-global/lib/node_modules/@ali/claude-code/cli.js'),
    resolve('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    ...resolveFromWhich(),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error('Could not locate Claude Code bundle.')
}

function resolveFromWhich(): string[] {
  try {
    const which = execSync('which claude', { encoding: 'utf-8' }).trim()
    const real = execSync(`readlink -f "${which}"`, { encoding: 'utf-8' }).trim()
    const dir = dirname(real)
    return [resolve(dir, 'cli.js'), resolve(dir, '../cli.js')]
  } catch {
    return []
  }
}

const bundlePath = process.env['CLAUDE_CODE_BUNDLE'] ?? findClaudeCodeBundle()
const backupPath = bundlePath + '.qoder-bridge.bak'

if (!existsSync(backupPath)) {
  console.error(`No backup found at: ${backupPath}`)
  console.error('Cannot revert — original backup is missing.')
  process.exit(1)
}

const current = readFileSync(bundlePath, 'utf-8')
if (!current.includes(PATCH_END_MARKER)) {
  console.log('Bundle does not appear to be patched — nothing to revert.')
  process.exit(0)
}

copyFileSync(backupPath, bundlePath)
console.log(`Reverted Claude Code bundle from backup: ${backupPath}`)
