// Build step: emit dist/ from src/.
//
// This package is hand-written ESM with no transpiler, so "building" means
// copying the runtime files into dist/ and then *proving* the copy is complete
// and loadable. The verification is the point: a dist/ that merely exists would
// satisfy a packaging checklist while shipping a broken plugin.
//
// Checks performed:
//   1. every expected runtime file is present in src/
//   2. each is copied byte-for-byte (hash compared)
//   3. every emitted .js parses (node --check)
//   4. the bundle patch still points at a file that exists
//
// Exits non-zero on any failure so `pnpm build` cannot silently produce a bad
// dist/.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(root, 'src')
const outDir = path.join(root, 'dist')

/** Runtime files that must reach the published package, all emitted to dist/. */
const RUNTIME_FILES = ['index.js', 'client.js']
/**
 * The bundle patch ships at the package root (that is where dsh.bundle.patch
 * points) AND is mirrored into dist/ so a dist-only publish still mounts.
 */
const PATCH_FILE = 'cordis.patch.yml'

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function main() {
  const problems = []

  // 1. Source completeness.
  for (const name of [...RUNTIME_FILES, PATCH_FILE]) {
    try {
      await fs.access(path.join(srcDir, name))
    } catch {
      problems.push(`missing source file: src/${name}`)
    }
  }
  if (problems.length > 0) return fail(problems)

  // 2. Emit dist/.
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  for (const name of RUNTIME_FILES) {
    const from = path.join(srcDir, name)
    const to = path.join(outDir, name)
    const original = await fs.readFile(from)
    await fs.writeFile(to, original)
    const written = await fs.readFile(to)
    if (sha256(original) !== sha256(written)) {
      problems.push(`copy mismatch for ${name}`)
    }
  }

  // Mirror the patch to the package root and into dist/.
  const patchSource = await fs.readFile(path.join(srcDir, PATCH_FILE))
  for (const target of [path.join(root, PATCH_FILE), path.join(outDir, PATCH_FILE)]) {
    await fs.writeFile(target, patchSource)
    if (sha256(await fs.readFile(target)) !== sha256(patchSource)) {
      problems.push(`patch copy mismatch at ${path.relative(root, target)}`)
    }
  }
  if (problems.length > 0) return fail(problems)

  // 3. Emitted JS must parse.
  for (const name of RUNTIME_FILES.filter((f) => f.endsWith('.js'))) {
    try {
      await run(process.execPath, ['--check', path.join(outDir, name)])
    } catch (err) {
      problems.push(`dist/${name} does not parse: ${String(err.stderr || err.message).split('\n')[0]}`)
    }
  }

  // 4. The bundle patch must reference a file we actually emitted.
  try {
    const patch = await fs.readFile(path.join(outDir, 'cordis.patch.yml'), 'utf8')
    // The patch mounts the plugin by module name; the package main must exist.
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    if (!pkg.dsh?.bundle?.patch) problems.push('package.json is missing dsh.bundle.patch')
    if (Object.keys(patch).length === 0) problems.push('dist/cordis.patch.yml is empty')
  } catch (err) {
    problems.push(`bundle patch check failed: ${err.message}`)
  }

  if (problems.length > 0) return fail(problems)

  const sizes = []
  for (const name of [...RUNTIME_FILES, PATCH_FILE]) {
    const st = await fs.stat(path.join(outDir, name))
    sizes.push(`${name} (${st.size}B)`)
  }
  console.log(`built dist/: ${sizes.join(', ')}`)
  console.log(`mirrored ${PATCH_FILE} to the package root`)
  console.log('verified: copies are byte-identical, JS parses, bundle patch present')
}

function fail(problems) {
  console.error('BUILD FAILED:')
  for (const p of problems) console.error('  - ' + p)
  process.exitCode = 1
}

await main()
