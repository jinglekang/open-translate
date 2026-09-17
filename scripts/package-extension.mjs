// Invoked by pnpm package after a successful build. No platform-specific ZIP tools required.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist')

try {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'))
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version) || pkg.version !== manifest.version) {
    throw new Error('package.json and the built manifest must have the same numeric version.')
  }

  const files = Object.create(null)
  await collectFiles(dist)
  for (const required of [
    'manifest.json', 'service-worker.js', 'page-runtime.js',
    'popup/index.html', 'options/index.html',
  ]) {
    if (!files[required]) throw new Error(`Missing build output: ${required}`)
  }

  const archive = zipSync(files, { level: 6 })
  const output = join(root, 'releases', `open-translate-${manifest.version}.zip`)
  const temporary = `${output}.${randomUUID()}.tmp`
  await mkdir(dirname(output), { recursive: true })
  try {
    // Finish writing before replacing an existing package of the same version.
    await writeFile(temporary, archive, { flag: 'wx' })
    await rename(temporary, output)
  } finally {
    await rm(temporary, { force: true })
  }
  console.log(`Packaged ${Object.keys(files).length} files (${(archive.length / 1024 / 1024).toFixed(2)} MiB): ${output}`)

  async function collectFiles(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const archivePath = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        await collectFiles(path, `${archivePath}/`)
      } else if (entry.isFile()) {
        files[archivePath] = await readFile(path)
      } else {
        throw new Error(`Unsupported build entry (symlinks are not packaged): ${archivePath}`)
      }
    }
  }
} catch (error) {
  console.error(`Packaging failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
