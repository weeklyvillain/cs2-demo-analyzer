// Builds the demo extractor (Rust, in extractor/) and copies the binary to
// where the app looks for it: bin/<platform>/parser[.exe].
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const platformDir = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]
if (!platformDir) {
  console.error(`Unsupported platform: ${process.platform}`)
  process.exit(1)
}
const exe = process.platform === 'win32' ? 'parser.exe' : 'parser'

try {
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'extractor', 'Cargo.toml')], {
    stdio: 'inherit',
  })
} catch (err) {
  console.error('Building the demo extractor failed. Is the Rust toolchain installed? (https://rustup.rs)')
  process.exit(typeof err.status === 'number' ? err.status : 1)
}

const built = path.join(root, 'extractor', 'target', 'release', exe)
const outDir = path.join(root, 'bin', platformDir)
fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(built, path.join(outDir, exe))
console.log(`Demo extractor copied to ${path.join('bin', platformDir, exe)}`)
