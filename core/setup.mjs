// ENGRAM core: setup (D-A967). The person picks one folder; Engram does
// the rest on the spot: the memory is created there (or adopted if one
// exists), the rules block goes into their CLAUDE.md, the `engram` command
// is written and put on their path, and the server is told which memory
// is selected. `engram check` is the checklist: fully installed when every
// line is ok. There is no guide and no prompt: nothing to hand to an AI.

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { configDir, configPath, readConfig, Repository, resolveRepoPath } from './repository.mjs';
import { RULES_VERSION, installedRulesVersion, installClaudeBlock } from './rules.mjs';
import { claudeMdPath } from './cli-paths.mjs';
import { initRepository } from './engram.mjs';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = join(APP_ROOT, 'core', 'cli.mjs');

function launchConfig() {
    try { return JSON.parse(readFileSync(join(APP_ROOT, 'tools', 'launch.config.json'), 'utf8')); } catch { return {}; }
}

export const PORT = Number(launchConfig().port || 5187);
export const SERVER_URL = `http://127.0.0.1:${PORT}`;

export function appVersion() {
    try { return JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/** The runtime the command runs on: node in development, Engram's own binary in node mode when installed. */
export function runtime() {
    return process.execPath;
}

export function shimDir() { return join(configDir(), 'bin'); }
export function shimPath() { return join(shimDir(), process.platform === 'win32' ? 'engram.cmd' : 'engram'); }

/** The `engram` command as a file on the path: one line that runs the command on the runtime this process has. */
export function writeShim() {
    mkdirSync(shimDir(), { recursive: true });
    const exe = runtime();
    const text = process.platform === 'win32'
        ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${CLI}" %*\r\n`
        : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${CLI}" "$@"\n`;
    const file = shimPath();
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text, 'utf8');
    if (process.platform !== 'win32') { try { chmodSync(file, 0o755); } catch { /* fine */ } }
    return file;
}

const samePath = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** The user's own PATH as Windows stores it (not this process's), or '' elsewhere. */
function userPathWindows() {
    const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
    const m = (r.stdout || '').match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)$/m);
    return m ? m[1].trim() : '';
}

/** Whether the shim folder is on the path: this process's, or the user's stored one on Windows. */
export function shimOnPath() {
    const dir = shimDir();
    const here = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    if (here.some((p) => samePath(p, dir))) return true;
    if (process.platform === 'win32') return userPathWindows().split(';').some((p) => samePath(p, dir));
    return false;
}

/** Put the shim folder on the user's path (Windows: the user's Path value, appended, never truncated). */
export function addShimToPath() {
    const dir = shimDir();
    if (shimOnPath()) return 'present';
    if (process.platform !== 'win32') return 'manual';
    const script = `$d='${dir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $p) { $p='' }; if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User') }`;
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? 'added' : 'failed';
}

/** Everything the server does at start so the command works the moment a memory is picked: config, shim. */
export function prepare() {
    mkdirSync(configDir(), { recursive: true });
    if (!existsSync(configPath())) writeFileSync(configPath(), '{}\n', 'utf8');
    return { shim: writeShim() };
}

/**
 * The one setup act (D-A967): the person picked a folder. Create the memory
 * there, or adopt the one already there; select it; install the rules into
 * CLAUDE.md; write the command and put it on the path. Returns what was done.
 */
export function setupMemory(dir, { title } = {}) {
    if (!dir || !String(dir).trim()) throw new Error('a folder is required');
    const root = resolve(String(dir).trim());
    const lower = root.toLowerCase();
    if (lower.startsWith(APP_ROOT.toLowerCase())) throw new Error('the memory cannot live inside the application folder');
    const r = initRepository(root, { title: title || undefined });
    const rules = installClaudeBlock(claudeMdPath());
    const shim = writeShim();
    const path = addShimToPath();
    return { repository: r.repo.root, fresh: r.fresh, device: r.device, rules, shim, path, stats: r.repo.stats() };
}

/** A native folder dialog on Windows (PowerShell, no dependency). Returns the path or null when cancelled. */
export function pickFolder(startAt) {
    if (process.platform !== 'win32') return null;
    const initial = startAt ? String(startAt).replace(/'/g, "''") : '';
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Pick the folder Engram writes your memories into'",
        '$d.ShowNewFolderButton = $true',
        initial ? `$d.SelectedPath = '${initial}'` : '',
        '$f = New-Object System.Windows.Forms.Form',
        '$f.TopMost = $true',
        "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ].filter(Boolean).join('; ');
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
    const out = (r.stdout || '').trim();
    return out || null;
}

async function serverAnswers() {
    try {
        const r = await fetch(`${SERVER_URL}/api/status`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch {
        return false;
    }
}

/**
 * The checklist: what is in place on this computer. Each item is one
 * observable fact with an ok flag and a line to repeat to the person.
 */
export async function check() {
    const items = [];
    const add = (key, ok, text, fix) => items.push({ key, ok, text, ...(fix && !ok ? { fix } : {}) });
    add('runtime', existsSync(runtime()), `runtime ${runtime()}`);
    add('command', existsSync(shimPath()), `command file ${shimPath()}`, 'engram shim');
    add('path', shimOnPath(), `command folder on the path (${shimDir()})`, 'engram shim, then a new shell');
    add('config', existsSync(configPath()), `config ${configPath()}`, 'start Engram from the tray once');
    let repo = null;
    try { repo = new Repository(resolveRepoPath()); if (!repo.exists()) repo = null; } catch { /* none */ }
    const cfg = readConfig();
    add('memory', !!repo, repo ? `memory ${repo.root} (${repo.stats().engrams} engrams)` : (cfg.repository ? `memory ${cfg.repository} is selected but not there` : 'no memory selected'), 'open Setup and pick a folder, or engram setup <folder>');
    const v = installedRulesVersion(claudeMdPath());
    add('rules', v === RULES_VERSION, v === RULES_VERSION ? `rules version ${v} installed in ${claudeMdPath()}` : (v ? `rules version ${v} installed, application has ${RULES_VERSION}` : `rules not installed in ${claudeMdPath()}`), 'engram rules --install');
    add('device', !!(cfg.device && cfg.device.id), cfg.device ? `this computer is ${cfg.device.name} (${cfg.device.id})` : 'this computer is not registered yet', 'engram setup registers it');
    add('server', await serverAnswers(), `server ${SERVER_URL}`, 'start Engram from the tray');
    return { ok: items.every((i) => i.ok), version: appVersion(), rulesVersion: RULES_VERSION, items };
}

export function renderCheck(c) {
    const L = [`Engram ${c.version}: ${c.ok ? 'fully installed' : 'not yet fully installed'}`];
    for (const i of c.items) L.push(`  ${i.ok ? 'ok  ' : 'FAIL'} ${i.text}${i.fix ? '  ->  ' + i.fix : ''}`);
    return L.join('\n');
}
