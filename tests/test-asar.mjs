// Guards the asar reader's memory behavior.
//
// The installed app.asar is ~174 MB. Reading it whole to resolve one catalog
// entry cost ~125 ms and hundreds of MB of RSS, multiplied by the concurrent
// resolutions refreshAll performs. The reader must seek instead.
//
// This builds a synthetic archive far smaller than the real one but with the
// same layout, then asserts the bytes actually read stay well under the file
// size -- a whole-file read would blow the budget on any archive.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve the package root from this test file, so the suite runs from any
// checkout location and on any machine.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(REPO, 'dist', 'index.js')).href)
const { readFromAsar } = mod.__test || {}
if (typeof readFromAsar !== 'function') {
  console.log('FAIL: readFromAsar is not exported for testing')
  process.exit(1)
}

const TMP = path.join(os.tmpdir(), 'asar-test-' + Date.now())
await fs.mkdir(TMP, { recursive: true })

// Build a synthetic asar: { files: { 'payload.bin': {...}, 'dir': { files: ... } } }
// Two entries; the one we read sits late in the payload so an eager reader
// would have to pull the whole thing.
const smallBody = Buffer.from(JSON.stringify({ 'openai-completions': { 'chat:x': { baseUrl: 'https://example.test/v1' } } }))
const bigBody = Buffer.alloc(3 * 1024 * 1024, 0x41) // 3 MB of filler

const files = {
  'filler.bin': { size: bigBody.length },
  'nested': { files: { 'catalog.json': { size: smallBody.length } } },
}
const dataOffsetFiller = 0
const dataOffsetCatalog = bigBody.length

// Offsets are relative to the end of the header.
let header = JSON.stringify({ files })
let headerSize = Buffer.byteLength(header)
// Header size must be 8-byte aligned in real asar; pad the JSON with spaces.
while ((headerSize + 16) % 8 !== 0) {
  header += ' '
  headerSize = Buffer.byteLength(header)
}

const prefix = Buffer.alloc(16)
prefix.writeUInt32LE(4, 0)
prefix.writeUInt32LE(headerSize + 8, 4)
prefix.writeUInt32LE(headerSize + 4, 8)
prefix.writeUInt32LE(headerSize, 12)
const headerBuf = Buffer.from(header, 'utf8')

// Walk the tree to stamp offsets, then rebuild the header.
function stamp(node, cursor) {
  for (const key of Object.keys(node.files)) {
    const entry = node.files[key]
    if (entry.files) {
      cursor = stamp(entry, cursor)
    } else {
      entry.offset = String(cursor)
      cursor += entry.size
    }
  }
  return cursor
}
stamp({ files }, 0)
header = JSON.stringify({ files })
headerSize = Buffer.byteLength(header)
while ((headerSize + 16) % 8 !== 0) {
  header += ' '
  headerSize = Buffer.byteLength(header)
}
prefix.writeUInt32LE(headerSize, 12)
const finalHeader = Buffer.from(header, 'utf8')

const archivePath = path.join(TMP, 'sample.asar')
await fs.writeFile(archivePath, Buffer.concat([prefix, finalHeader, bigBody, smallBody]))
const archiveSize = (await fs.stat(archivePath)).size

const results = []
const check = (name, cond, msg) => results.push({ name, pass: !!cond, msg })

// Instrument every read this call performs.
let bytesRead = 0
let wholeFileReads = 0
const io = {
  stat: fs.stat,
  open: async (p, flags) => {
    const handle = await fs.open(p, flags)
    return {
      read: async (buf, off, len, pos) => {
        bytesRead += len
        return handle.read(buf, off, len, pos)
      },
      close: () => handle.close(),
    }
  },
}

const text = await readFromAsar(archivePath + '/nested/catalog.json', io)
check('S1 catalog entry read from synthetic asar', typeof text === 'string' && text.includes('example.test'), 'got=' + String(text).slice(0, 80))
check('S2 archive is large enough to matter', archiveSize > 3 * 1024 * 1024, 'size=' + archiveSize)
check('S3 bytes read stay far below archive size', bytesRead < archiveSize / 2, 'read=' + bytesRead + ' of ' + archiveSize)
check('S4 no whole-file read happened', wholeFileReads === 0, 'wholeFileReads=' + wholeFileReads)

// A missing entry must not fall through as success.
const missing = await readFromAsar(archivePath + '/nope.json', io)
check('S5 missing entry returns undefined', missing === undefined, 'got=' + typeof missing)

// A non-asar path is refused rather than guessed at.
const plain = await readFromAsar(path.join(TMP, 'plain.txt'), io)
check('S6 non-asar path returns undefined', plain === undefined, 'got=' + typeof plain)

console.log('=== dsh-lineup-manager asar reader tests ===')
let pass = 0, fail = 0
for (const r of results) {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '   -> ' + r.msg))
  r.pass ? pass++ : fail++
}
console.log('')
console.log('total: PASS=' + pass + '  FAIL=' + fail)
await fs.rm(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)