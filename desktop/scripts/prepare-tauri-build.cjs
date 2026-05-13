const { spawnSync } = require('node:child_process');
const path = require('node:path');

const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const backendDir = path.join(repoRoot, 'backend');

function runPnpm(args, cwd) {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'corepack', 'pnpm', ...args], {
          cwd,
          stdio: 'inherit',
          shell: false,
        })
      : spawnSync('corepack', ['pnpm', ...args], {
          cwd,
          stdio: 'inherit',
          shell: false,
        });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runPnpm(['build'], desktopDir);
runPnpm(['build'], backendDir);
runPnpm(['build:sidecar'], backendDir);
