import * as esbuild from 'esbuild'
import { execSync } from 'child_process'
import { mkdirSync } from 'fs'

// Step 1: Compile all TypeScript files with tsc (preserves directory structure)
console.log('Compiling TypeScript...')
execSync('./node_modules/.bin/tsc --outDir dist --declaration', { stdio: 'inherit' })

// Step 2: Bundle patch scripts as standalone executables
mkdirSync('./dist/patch', { recursive: true })
for (const name of ['apply', 'revert']) {
  await esbuild.build({
    entryPoints: [`src/patch/${name}.ts`],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    outfile: `dist/patch/${name}.js`,
    sourcemap: true,
  })
}

console.log('Build complete.')
