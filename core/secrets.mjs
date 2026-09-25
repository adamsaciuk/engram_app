// ENGRAM core: the secret store. A secret (an API key, a storage key pair)
// is kept for this user on this computer only, never in a memory: on
// Windows wrapped with the user's DPAPI, elsewhere (or with
// ENGRAM_KEY_STORE=file) a file only the user can read.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDir } from './repository.mjs';

function useFileStore() {
    return process.env.ENGRAM_KEY_STORE === 'file' || process.platform !== 'win32';
}

export function keysDir() {
    return join(configDir(), 'keys');
}

export function keyPath(id, suffix = 'key') {
    return join(keysDir(), `${id}.${suffix}`);
}

function ps(command) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`the Windows credential protection call failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    return r.stdout.trim();
}

function dpapiWrap(buf) {
    return ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('${buf.toString('base64')}'), $null, 'CurrentUser'))`);
}

function dpapiUnwrap(b64) {
    return Buffer.from(ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64}'), $null, 'CurrentUser'))`), 'base64');
}

/** Store a secret for this user on this computer. Returns the path. */
export function storeSecret(id, buf, suffix = 'key') {
    mkdirSync(keysDir(), { recursive: true });
    const file = keyPath(id, suffix);
    if (useFileStore()) {
        writeFileSync(file, 'file:' + buf.toString('base64') + '\n', { mode: 0o600 });
        try { chmodSync(file, 0o600); } catch { /* windows */ }
    } else {
        writeFileSync(file, 'dpapi:' + dpapiWrap(buf) + '\n');
    }
    return file;
}

export function hasSecret(id, suffix = 'key') {
    return existsSync(keyPath(id, suffix));
}

/** Load a secret, or null when this computer does not hold it. */
export function loadSecret(id, suffix = 'key') {
    const file = keyPath(id, suffix);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8').trim();
    if (text.startsWith('file:')) return Buffer.from(text.slice(5), 'base64');
    if (text.startsWith('dpapi:')) return dpapiUnwrap(text.slice(6));
    return null;
}
