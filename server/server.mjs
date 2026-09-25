// ENGRAM local server. ATEO launcher standard v1 ("ateo-launcher/1"),
// compliant under law 9: this repo keeps its own server because it answers
// an API (status, cortex, search, recall, Echos, sessions, the live stream,
// setup, add and edit) as well as static files. The launcher blocks below
// (identity, probe, daemon, refusals, stop) are copied from the canonical
// the launcher standard's canonical serve.mjs unchanged in behaviour. Port and
// identity: tools/launch.config.json.
//
// Always on (D-A771): every write by the command posts to /api/event, and
// the cortex folder is watched as the backstop; /api/live streams both to
// the tray and the page as server-sent events.
//
//   node server/server.mjs --launch [/path] [--no-browser]
//   node server/server.mjs --serve | --status | --stop

import http from 'node:http';
import { spawn } from 'node:child_process';
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Repository, resolveRepoPath, thisDevice, readConfig, writeConfig, configPath, STRUCTURAL } from '../core/repository.mjs';
import { recall } from '../core/recall.mjs';
import { search, brief } from '../core/search.mjs';
import { readMaps } from '../core/index.mjs';
import { RULES_VERSION, installedRulesVersion, installClaudeBlock } from '../core/rules.mjs';
import { claudeMdPath } from '../core/cli-paths.mjs';
import { storageOf, hasCredentials, usage, budgetsOf, bank, fetchArtefact } from '../core/storage.mjs';
import { engram, editEngram, openContainer } from '../core/engram.mjs';
import { prepare as prepareSetup, setupMemory, pickFolder, shimDir, shimPath, shimOnPath, writeShim, addShimToPath, check as setupCheck, APP_ROOT as SETUP_ROOT } from '../core/setup.mjs';

const STANDARD = 'ateo-launcher/1';
const SELF = fileURLToPath(import.meta.url);
const SERVER_DIR = dirname(SELF);
const ROOT = resolve(SERVER_DIR, '..');
const UI = join(SERVER_DIR, 'ui');
const TOOLS = join(ROOT, 'tools');
const LOG = join(TOOLS, 'serve.log');

const cfgPath = join(TOOLS, 'launch.config.json');
if (!existsSync(cfgPath)) {
    console.error(`[launcher] missing ${cfgPath}`);
    process.exit(1);
}
const CFG = JSON.parse(readFileSync(cfgPath, 'utf8'));
const APP = String(CFG.app || '');
let PORT = Number(CFG.port);

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const startedAt = new Date().toISOString();
const norm = (p) => resolve(p).toLowerCase();
const ACTIVE_MS = 30 * 60 * 1000;

// ------------------------------------------------------------------- api ---

function json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

function currentRepo() {
    const repo = new Repository(resolveRepoPath());
    if (!repo.exists()) throw new Error(`no memory at ${repo.root}`);
    return repo;
}

function readBody(req) {
    return new Promise((res) => {
        let s = '';
        req.on('data', (d) => { s += d; if (s.length > 1e6) req.destroy(); });
        req.on('end', () => res(s));
        req.on('error', () => res(''));
    });
}

async function bodyJson(req) {
    try { return JSON.parse(await readBody(req) || '{}'); } catch { return null; }
}

function echoView(e) {
    return { id: e.id, kind: e.kind, when: e.when, device: e.device, session: e.session, container: e.container, title: e.title, echo: e.echo, tags: e.tags, links: e.links, back: e.back, decision: e.decision, artefacts: e.artefacts, edited: e.edited || '', superseded: !!(e.back && e.back.superseded_by && e.back.superseded_by.length) };
}

function recentEngrams(repo, n = 50) {
    // the memories a person watches arrive: structural writes (digests, opens, moves, the genesis) stay off the stream
    return repo.allEngrams().filter((e) => !STRUCTURAL.has(e.kind)).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, n).map(echoView);
}

function sessionsView(repo) {
    const now = Date.now();
    return repo.listSessions().map((s) => ({ ...s, active: !s.rested && s.lastEngram && now - Date.parse(s.lastEngram) < ACTIVE_MS }));
}

async function api(req, res, url) {
    const p = url.pathname;
    try {
        if (p === '/api/status') {
            const cfg = readConfig();
            let repo;
            try { repo = currentRepo(); } catch (e) { return json(res, 200, { repository: null, error: e.message, device: cfg.device || null, version: version(), rulesVersion: RULES_VERSION }); }
            const sessions = sessionsView(repo);
            const recent = recentEngrams(repo, 1)[0] || null;
            return json(res, 200, {
                repository: repo.root, stats: repo.stats(),
                device: cfg.device || thisDevice(), version: version(),
                rulesVersion: RULES_VERSION, rulesInMemory: rulesVersion(repo), rulesInstalled: installedRulesVersion(claudeMdPath()), claudeMd: claudeMdPath(),
                storage: storageView(repo, cfg.device),
                sessionsActive: sessions.filter((s) => s.active).length, lastEngram: recent ? recent.when : null, lastEngramDevice: recent ? recent.device : null,
                contradictions: readMaps(repo, repo.allEngrams()).maps.get('').contradictions.length,
                started: startedAt,
            });
        }
        if (p === '/api/cortex') {
            const repo = currentRepo();
            const { maps } = readMaps(repo, repo.allEngrams());
            return json(res, 200, repo.listContainers().map((c) => { const m = maps.get(c); return { path: c, title: m.title, counts: m.counts, decisions: m.decisions.length, contradictions: m.contradictions.length, gaps: m.gaps.length, newest: m.newest, digest: m.digest }; }));
        }
        if (p === '/api/map') {
            const repo = currentRepo();
            const { maps } = readMaps(repo, repo.allEngrams());
            const m = maps.get((url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, ''));
            return m ? json(res, 200, m) : json(res, 404, { error: 'no such container' });
        }
        if (p === '/api/echos') {
            const repo = currentRepo();
            const c = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
            return json(res, 200, repo.listEngrams(c).map(echoView).reverse());
        }
        if (p === '/api/recent') {
            const repo = currentRepo();
            return json(res, 200, recentEngrams(repo, Number(url.searchParams.get('n') || 50)));
        }
        if (p.startsWith('/api/echo/')) {
            const repo = currentRepo();
            const e = repo.findEngram(p.slice('/api/echo/'.length));
            if (!e) return json(res, 404, { error: 'no such engram' });
            const linked = {};
            for (const l of e.links || []) (linked[l.kind] = linked[l.kind] || []).push({ id: l.id, why: l.why, line: lineOf(repo, l.id) });
            for (const [k, ids] of Object.entries(e.back || {})) if (ids.length) linked[k] = ids.map((id) => ({ id, line: lineOf(repo, id) }));
            const recalledBy = repo.readTraces().filter((t) => (t.handed || []).includes(e.id)).map((t) => ({ when: t.when, session: t.session, device: t.device, task: t.task })).slice(-20).reverse();
            return json(res, 200, { engram: e, linked, artefacts: repo.listArtefacts().filter((a) => a.engram === e.id), recalledBy, file: repo.engramFile(e.id) });
        }
        if (p === '/api/search') {
            const repo = currentRepo();
            const q = url.searchParams.get('q') || '';
            if (!q.trim()) return json(res, 400, { error: 'q is required' });
            return json(res, 200, search(repo, q));
        }
        if (p === '/api/brief') {
            const repo = currentRepo();
            const r = brief(repo, url.searchParams.get('path') || '', { attention: Number(url.searchParams.get('attention') || 4000) });
            return json(res, 200, r);
        }
        if (p === '/api/recall') {
            // the briefing exactly as a session receives it; a person browsing does not train the routes
            const repo = currentRepo();
            const q = url.searchParams.get('q') || '';
            if (!q.trim()) return json(res, 400, { error: 'q is required' });
            const attention = Number(url.searchParams.get('attention') || 8000);
            const r = recall(repo, q, { attention, mode: 'ai', write: false });
            return json(res, 200, { bundle: r.bundle, entered: r.entered, handed: r.handed, decisions: r.decisions, history: r.history, contradictions: r.contradictions, gaps: r.gaps, echos: r.echos, linked: r.linked, artefacts: r.artefacts, excluded: r.excluded, suggest: r.suggest, used: r.used, route: r.route, cost: r.cost, ms: r.ms, attention });
        }
        if (p === '/api/sessions') {
            const repo = currentRepo();
            return json(res, 200, sessionsView(repo));
        }
        if (p === '/api/artefacts') {
            const repo = currentRepo();
            return json(res, 200, repo.listArtefacts());
        }
        if (p === '/api/rules') {
            const repo = currentRepo();
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(readFileSync(join(repo.root, 'ENGRAM.md'), 'utf8'));
        }
        if (p === '/api/live') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
            res.write(': engram live\n\n');
            try { const repo = currentRepo(); send(res, { type: 'hello', recent: recentEngrams(repo, 50), sessions: sessionsView(repo), at: new Date().toISOString() }); } catch (e) { send(res, { type: 'hello', error: e.message }); }
            clients.add(res);
            req.on('close', () => clients.delete(res));
            return;
        }
        if (p === '/api/event' && req.method === 'POST') {
            const ev = await bodyJson(req);
            if (!ev) return json(res, 400, { error: 'bad json' });
            broadcast({ ...ev, type: ev.type || 'event', at: ev.at || new Date().toISOString(), source: 'command' });
            return json(res, 200, { ok: true, listeners: clients.size });
        }
        if (p === '/api/engram' && req.method === 'POST') {
            // the person adds a memory from the page (D-A973)
            const repo = currentRepo();
            const b = await bodyJson(req);
            if (!b) return json(res, 400, { error: 'bad json' });
            const container = String(b.container || '').trim();
            if (b.newContainer && !repo.hasContainer(container)) openContainer(repo, container, b.title ? String(b.title) : undefined);
            const e = engram(repo, {
                container, kind: b.kind || (b.decision ? 'decision' : 'action'), name: b.name, stimulus: b.stimulus, echo: b.echo, done: b.done, decision: b.decision,
                tags: [].concat(b.tags || []).flatMap((t) => String(t).split(',')).map((s) => s.trim()).filter(Boolean), session: b.session,
            });
            return json(res, 200, echoView(e));
        }
        if (p.startsWith('/api/engram/') && (req.method === 'POST' || req.method === 'PUT')) {
            // the person edits a memory from the page (D-A973)
            const repo = currentRepo();
            const b = await bodyJson(req);
            if (!b) return json(res, 400, { error: 'bad json' });
            const fields = { ...b };
            if (fields.tags !== undefined) fields.tags = [].concat(fields.tags || []).flatMap((t) => String(t).split(',')).map((s) => s.trim()).filter(Boolean);
            const e = editEngram(repo, p.slice('/api/engram/'.length), fields);
            return json(res, 200, echoView(e));
        }
        if (p === '/api/bank' && req.method === 'POST') {
            // the person's act from the page: the confirmation happened there; byUser is explicit in the body
            const repo = currentRepo();
            const body = await bodyJson(req);
            if (!body) return json(res, 400, { error: 'bad json' });
            const a = await bank(repo, String(body.id || ''), { byUser: body.byUser === true });
            broadcast({ type: 'artefact', id: a.id, engram: a.engram, container: a.container, device: a.bankedBy, line: `${a.name} banked`, at: a.banked, source: 'page' });
            return json(res, 200, a);
        }
        if (p === '/api/fetch' && req.method === 'POST') {
            const repo = currentRepo();
            const body = await bodyJson(req);
            if (!body) return json(res, 400, { error: 'bad json' });
            const r = await fetchArtefact(repo, String(body.id || ''), { reason: body.reason });
            return json(res, 200, r);
        }
        if (p === '/api/debug') {
            // what this server process actually sees: for the day a memory "vanishes"
            const cp = configPath();
            let readable = null;
            try { readable = readFileSync(cp, 'utf8').length; } catch (e) { readable = e.code || e.message; }
            const list = (d) => { try { return readdirSync(d); } catch (e) { return e.code || e.message; } };
            return json(res, 200, { pid: process.pid, execPath: process.execPath, cwd: process.cwd(), configPath: cp, configReadable: readable, home: homedir(), env: { APPDATA: process.env.APPDATA || null, LOCALAPPDATA: process.env.LOCALAPPDATA || null, USERPROFILE: process.env.USERPROFILE || null, ENGRAM_REPO: process.env.ENGRAM_REPO || null, ENGRAM_CONFIG_DIR: process.env.ENGRAM_CONFIG_DIR || null }, sees: { configDir: list(dirname(cp)) } });
        }
        if (p === '/api/check') {
            return json(res, 200, await setupCheck());
        }
        if (p === '/api/setup-state') {
            // everything the Setup page needs, whether or not a memory is selected
            const cfg = readConfig();
            let repo = null;
            try { repo = currentRepo(); } catch { /* none yet */ }
            const state = { repository: repo ? repo.root : (cfg.repository || null), exists: !!repo, device: cfg.device || null, claudeMd: claudeMdPath(), rulesVersion: RULES_VERSION, rulesInstalled: installedRulesVersion(claudeMdPath()), version: version(), appRoot: SETUP_ROOT, suggested: process.platform === 'win32' ? 'C:\\ENGRAM' : join(homedir(), 'engram') };
            if (repo) { state.stats = repo.stats(); state.title = repo.readTitle(''); }
            state.shim = { file: shimPath(), dir: shimDir(), exists: existsSync(shimPath()), onPath: shimOnPath() };
            return json(res, 200, state);
        }
        if (p === '/api/pick-folder' && req.method === 'POST') {
            const b = (await bodyJson(req)) || {};
            const path = pickFolder(b.startAt || readConfig().repository || '');
            return json(res, 200, { path });
        }
        if (p === '/api/setup' && req.method === 'POST') {
            const b = await bodyJson(req);
            if (!b) return json(res, 400, { error: 'bad json' });
            const act = String(b.action || '');
            if (act === 'use') {
                // the one act (D-A967): pick a folder, everything else follows
                const r = setupMemory(String(b.dir || ''), { title: b.title ? String(b.title) : undefined });
                watchRepository();
                broadcast({ type: 'memory', repository: r.repository, at: new Date().toISOString() });
                return json(res, 200, { ok: true, ...r, note: `${r.fresh ? 'Memory created' : 'Memory adopted'} at ${r.repository}. Rules ${r.rules.action}. Command ${r.path === 'added' ? 'added to your path (new shells see it)' : r.path === 'present' ? 'on your path' : 'written; add ' + shimDir() + ' to your path'}.` });
            }
            if (act === 'forget') {
                // start fresh (D-A977): the selection is cleared, the folder and its notes stay where they are
                const cfg = readConfig();
                const had = cfg.repository || null;
                writeConfig({ repository: null });
                if (watcher) { try { watcher.close(); } catch { /* fine */ } watcher = null; }
                broadcast({ type: 'memory', repository: null, at: new Date().toISOString() });
                return json(res, 200, { ok: true, forgot: had, note: had ? `Forgotten. ${had} is untouched on disk; pick a folder to start fresh.` : 'No memory was selected.' });
            }
            if (act === 'rules') { const r = installClaudeBlock(claudeMdPath()); return json(res, 200, { ok: true, ...r, note: `rules ${r.action} (version ${r.version}) in ${r.path}` }); }
            if (act === 'shim') { writeShim(); const r = addShimToPath(); return json(res, 200, { ok: true, path: r, note: r === 'added' ? 'the engram command is on the path for new shells' : r === 'present' ? 'the engram command was already on the path' : 'command written; add ' + shimDir() + ' to the path by hand' }); }
            return json(res, 400, { error: `unknown setup action "${act}"` });
        }
        return json(res, 404, { error: 'no such api' });
    } catch (e) {
        return json(res, 500, { error: e.message });
    }
}

function storageView(repo, device) {
    const st = storageOf(repo);
    if (!st) return { configured: false };
    const u = device ? usage(repo, device.id) : { todayBytes: 0 };
    return { configured: true, endpoint: st.endpoint, bucket: st.bucket, prefix: st.prefix, key: hasCredentials(repo), todayMB: Math.round(u.todayBytes / 1e5) / 10, budgets: budgetsOf(repo) };
}

function lineOf(repo, id) {
    const e = repo.findEngram(id);
    return e ? (e.kind === 'decision' && e.decision ? e.decision : e.title || e.echo || '').slice(0, 120) : '(missing)';
}

function version() {
    try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; }
}

function rulesVersion(repo) {
    try { return Number((readFileSync(join(repo.root, 'ENGRAM.md'), 'utf8').match(/version (\d+)/) || [])[1] || 0); } catch { return 0; }
}

// ------------------------------------------------------------- the live ---

const clients = new Set();

function send(res, event) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { clients.delete(res); }
}

function broadcast(event) {
    for (const c of clients) send(c, event);
}

let watcher = null;
let watchTimer = null;
function watchRepository() {
    try {
        const repo = currentRepo();
        if (watcher) watcher.close();
        watcher = watch(repo.cortex, { recursive: true }, (kind, file) => {
            if (!file || !String(file).endsWith('.md')) return;
            clearTimeout(watchTimer);
            watchTimer = setTimeout(() => broadcast({ type: 'change', file: String(file).replace(/\\/g, '/'), at: new Date().toISOString(), source: 'watch' }), 300);
        });
        watcher.on('error', () => { watcher = null; });
        console.log(`[serve] watching ${repo.cortex}`);
    } catch (e) {
        console.log(`[serve] not watching: ${e.message}`);
    }
}

// ---------------------------------------------------------------- server ---

function runServer() {
    const server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400).end('bad request'); return; }
        const pathname = decodeURIComponent(url.pathname);

        if (pathname === '/__whoami') {
            return json(res, 200, { standard: STANDARD, app: APP, root: ROOT, port: PORT, pid: process.pid, started: startedAt });
        }
        if (pathname === '/__stop') {
            console.log(`[serve] ${APP} stopping on request (pid ${process.pid})`);
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'close' });
            res.end('stopping', () => setTimeout(() => process.exit(0), 80));
            return;
        }
        if (pathname.startsWith('/api/')) { api(req, res, url); return; }
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end('method not allowed'); return; }

        let filePath = resolve(UI, '.' + pathname);
        if (filePath !== UI && !filePath.startsWith(UI + sep)) { res.writeHead(404).end('not found'); return; }
        try {
            if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
            const size = statSync(filePath).size;
            res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-store' });
            if (req.method === 'HEAD') { res.end(); return; }
            const stream = createReadStream(filePath);
            stream.on('error', () => res.destroy());
            stream.pipe(res);
        } catch {
            res.writeHead(404).end('not found');
        }
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') { console.error(`[serve] port ${PORT} is already in use - refusing to fight for it.`); process.exit(1); }
        console.error(`[serve] ${err.message}`);
        process.exit(1);
    });
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[serve] ${APP} up - http://127.0.0.1:${PORT}/ (pid ${process.pid}, root ${ROOT}, ${STANDARD})`);
        try { prepareSetup(); } catch (e) { console.error(`[setup] ${e.message}`); }
        watchRepository();
        setInterval(() => broadcast({ type: 'heartbeat', at: new Date().toISOString() }), 25000).unref();
    });
}

// ----------------------------------------------------------------- probes ---

async function probeOnce() {
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${PORT}/__whoami`, { signal: AbortSignal.timeout(2000) });
    } catch (err) {
        const code = err?.code || err?.cause?.code;
        if (err?.name === 'TimeoutError' || code === 'ECONNRESET') return { kind: 'other' };
        return { kind: 'free' };
    }
    if (!res.ok) return { kind: 'other' };
    try {
        const info = await res.json();
        if (info && info.standard === STANDARD) return { kind: 'standard', info };
    } catch { /* not our JSON */ }
    return { kind: 'other' };
}

async function probe() {
    const first = await probeOnce();
    if (first.kind !== 'other') return first;
    await new Promise((r) => setTimeout(r, 350));
    return probeOnce();
}

const mine = (info) => info.app === APP && norm(info.root) === norm(ROOT);

function squatterHelp() {
    return `    See the owner:  netstat -ano | findstr :${PORT}\n    then end it:    taskkill /pid <PID> /f`;
}

function refuse(found) {
    if (found.kind === 'standard') {
        const i = found.info;
        console.error(`[launch] REFUSED: port ${PORT} is serving "${i.app}" from ${i.root} (pid ${i.pid}).`);
        console.error(`    That repo must release the port, or the registry in LAUNCHER-STANDARD.md is broken.`);
    } else {
        console.error(`[launch] REFUSED: something that is NOT a standard server owns port ${PORT}.`);
        console.error(squatterHelp());
    }
    process.exit(2);
}

// ----------------------------------------------------------------- daemon ---

function rotateLog() {
    try {
        if (existsSync(LOG) && statSync(LOG).size > 512 * 1024) { rmSync(LOG + '.old', { force: true }); renameSync(LOG, LOG + '.old'); }
    } catch { /* not worth failing a launch over */ }
}

function daemonize() {
    rotateLog();
    const fd = openSync(LOG, 'a');
    const child = spawn(process.execPath, [SELF, '--serve'], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.unref();
    closeSync(fd);
    return child.pid;
}

function logTail() {
    try { return readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-15).join('\n'); } catch { return '(no serve.log yet)'; }
}

async function waitReady() {
    for (let i = 0; i < 50; i++) {
        const found = await probe();
        if (found.kind === 'standard') {
            if (mine(found.info)) return found.info;
            refuse(found);
        }
        await new Promise((r) => setTimeout(r, 120));
    }
    console.error(`[launch] the server did not come up on port ${PORT} within 6s.\n    Last lines of ${LOG}:\n${logTail()}\n    If the port is squatted:\n${squatterHelp()}`);
    process.exit(1);
}

function openBrowser(path) {
    const url = `http://127.0.0.1:${PORT}${path}`;
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return url;
}

// -------------------------------------------------------------- commands ---

async function cmdLaunch(path, noBrowser) {
    const found = await probe();
    let info;
    if (found.kind === 'standard' && mine(found.info)) {
        info = found.info;
        console.log(`[launch] ${APP} already up (pid ${info.pid}, started ${info.started}) - reusing it.`);
    } else if (found.kind === 'free') {
        daemonize();
        info = await waitReady();
        console.log(`[launch] ${APP} started detached (pid ${info.pid}) - no window, survives every console, stops only via STOP ENGRAM.bat / --stop.`);
    } else refuse(found);
    if (noBrowser) console.log(`[launch] ready at http://127.0.0.1:${PORT}${path} (browser skipped).`);
    else console.log(`[launch] opening ${openBrowser(path)}`);
}

async function cmdStatus() {
    const found = await probe();
    if (found.kind === 'free') console.log(`[status] port ${PORT} is free - ${APP} is not running.`);
    else if (found.kind === 'other') console.log(`[status] port ${PORT} is held by something that is NOT a standard server.\n${squatterHelp()}`);
    else if (mine(found.info)) console.log(`[status] ${APP} is UP - http://127.0.0.1:${PORT}/ (pid ${found.info.pid}, started ${found.info.started})`);
    else console.log(`[status] port ${PORT} is serving "${found.info.app}" from ${found.info.root} (pid ${found.info.pid}) - registry collision.`);
}

async function cmdStop() {
    const found = await probe();
    if (found.kind === 'free') { console.log(`[stop] nothing running on port ${PORT}.`); return; }
    if (found.kind === 'other') { console.error(`[stop] REFUSED: the thing on port ${PORT} is not a standard server - not mine to kill.\n${squatterHelp()}`); process.exit(2); }
    const i = found.info;
    try { await fetch(`http://127.0.0.1:${PORT}/__stop`, { signal: AbortSignal.timeout(1000) }); } catch { /* the repoll decides */ }
    for (let t = 0; t < 20; t++) {
        await new Promise((r) => setTimeout(r, 100));
        if ((await probe()).kind === 'free') { console.log(`[stop] "${i.app}" stopped (was pid ${i.pid}).`); return; }
    }
    console.error(`[stop] "${i.app}" (pid ${i.pid}) did not release port ${PORT} - end it by hand:\n${squatterHelp()}`);
    process.exit(1);
}

// ------------------------------------------------------------------- main ---

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const portArg = args[args.indexOf('--port') + 1];
if (has('--port') && portArg) PORT = Number(portArg);
const pathArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const openPath = pathArg && pathArg.startsWith('/') ? pathArg : '/';

if (has('--serve')) runServer();
else if (has('--launch')) await cmdLaunch(openPath, has('--no-browser'));
else if (has('--status')) await cmdStatus();
else if (has('--stop')) await cmdStop();
else {
    console.log(`Engram server (${STANDARD}) - ${APP} on port ${PORT}`);
    console.log(`usage: node server/server.mjs --launch [/path] [--no-browser] | --serve | --status | --stop`);
    await cmdStatus();
}
