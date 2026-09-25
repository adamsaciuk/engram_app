// Build the Windows installer: npm run dist
// Sets the 7-Zip filter to BCJ2 first. This laptop is ARM64 and
// electron-builder's packer otherwise applies the ARM64 filter to arm64
// PE files, which the NSIS stub cannot decode: the install completes with
// no exe (D-A321, the failure has no error surface). The env var is the
// whole fix; it is harmless on x64.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
if (!existsSync(bin)) {
    console.error('electron-builder is not installed. Run "npm install" first.');
    process.exit(1);
}
const r = spawnSync(bin, ['--win', 'nsis', ...process.argv.slice(2)], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, ELECTRON_BUILDER_7Z_FILTER: 'BCJ2' },
});
process.exit(r.status ?? 1);
