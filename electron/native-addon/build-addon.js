const { spawnSync } = require('child_process');
const path = require('path');

function main() {
  const isWindows = process.platform === 'win32';

  if (!isWindows) {
    console.log('[native-addon] Windows-only addon; skipping build on', process.platform);
    return;
  }

  const projectRoot = path.resolve(__dirname, '..', '..');
  const addonDir = path.join(projectRoot, 'electron', 'native-addon');

  console.log('[native-addon] Building Windows native addon in', addonDir);

  const result = spawnSync(
    process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp',
    ['rebuild', '--directory', addonDir],
    {
      stdio: 'inherit',
      shell: true,
      cwd: projectRoot,
    }
  );

  if (result.error) {
    console.error('[native-addon] Failed to spawn node-gyp:', result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error('[native-addon] node-gyp exited with code', result.status);
    process.exit(result.status ?? 1);
  }

  console.log('[native-addon] Build completed successfully.');
}

main();

