const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendDir, '..');
const desktopResourcesDir = path.join(
  repoRoot,
  'desktop',
  'src-tauri',
  'resources',
  'backend',
);
const entryFile = path.join(backendDir, 'dist', 'main.js');
const lockfile = path.join(backendDir, 'pnpm-lock.yaml');
const packageJsonFile = path.join(backendDir, 'package.json');
const bundledNodeBinary = path.join(
  desktopResourcesDir,
  process.platform === 'win32' ? 'node.exe' : 'node',
);
const bundledEntryFile = path.join(desktopResourcesDir, 'dist', 'main.js');

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

function resetResourcesDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.gitignore' || entry === 'README.txt') {
      continue;
    }
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

if (!fs.existsSync(entryFile)) {
  console.error(`Backend build entry not found: ${entryFile}`);
  process.exit(1);
}

if (!fs.existsSync(lockfile)) {
  console.error(`Backend lockfile not found: ${lockfile}`);
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soundcloud-backend-deploy-'));

try {
  fs.copyFileSync(packageJsonFile, path.join(tempRoot, 'package.json'));
  fs.copyFileSync(lockfile, path.join(tempRoot, 'pnpm-lock.yaml'));
  runPnpm(
    ['install', '--prod', '--frozen-lockfile', '--config.node-linker=hoisted'],
    tempRoot,
  );

  if (!fs.existsSync(path.join(tempRoot, 'node_modules'))) {
    console.error(`pnpm install did not produce node_modules at ${tempRoot}`);
    process.exit(1);
  }

  resetResourcesDir(desktopResourcesDir);
  fs.cpSync(tempRoot, desktopResourcesDir, {
    recursive: true,
    force: true,
  });
  fs.cpSync(path.join(backendDir, 'dist'), path.join(desktopResourcesDir, 'dist'), {
    recursive: true,
    force: true,
  });
  fs.copyFileSync(process.execPath, bundledNodeBinary);
  fs.rmSync(path.join(desktopResourcesDir, 'pnpm-lock.yaml'), { force: true });

  if (process.platform !== 'win32') {
    fs.chmodSync(bundledNodeBinary, 0o755);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`Bundled backend runtime ready: ${bundledNodeBinary}`);
console.log(`Bundled backend entry ready: ${bundledEntryFile}`);
