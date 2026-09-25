/*
 * ENGRAM tray. The product's face on the desktop: one icon, four states,
 * one normal window (the tray click opens it on Live, the menu on Search or Setup).
 * Live). It keeps the local server alive (server/server.mjs on the
 * registered port), listens to the live stream so the icon reads the
 * memory at a glance, and quits from its menu. Installed, it starts with
 * Windows unless the person turns that off. The core never needs this
 * shell; the shell needs the core.
 *
 * The server is spawned from Electron's own binary in node mode
 * (ELECTRON_RUN_AS_NODE), so an installed Engram needs no separate Node.
 */
const { app, Tray, Menu, shell, nativeImage, BrowserWindow, globalShortcut } = require("electron");
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const autostart = require('./autostart.cjs');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.mjs');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'launch.config.json'), 'utf8'));
const PORT = Number(CFG.port);
const APP = String(CFG.app);
const STANDARD = 'ateo-launcher/1';
const URL_ROOT = `http://127.0.0.1:${PORT}`;
const ICONS = path.join(ROOT, 'assets', 'states');


let tray = null;
let child = null; // the server we own, if we started it
let quitting = false;
let state = 'error';
let status = { text: 'starting…' };
let main = null;
let pulseTimer = null;
let live = null;

function logFile() {
    return path.join(app.getPath('userData'), 'logs', 'tray.log');
}
function slog(line) {
    try {
        fs.mkdirSync(path.dirname(logFile()), { recursive: true });
        fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch { /* never let logging take the app down */ }
}

process.on('uncaughtException', (err) => { slog(`FATAL ${err.stack || err.message}`); app.exit(1); });
app.disableHardwareAcceleration();
// The tray's data lives under the user's real profile, whatever APPDATA says
// (a launcher or a sandbox can redirect it, and the core ignores it too).
if (process.platform === 'win32') app.setPath('userData', path.join(require('os').homedir(), 'AppData', 'Local', 'Engram'));

// ------------------------------------------------------------ the server ---

async function whoami() {
    try {
        const r = await fetch(`${URL_ROOT}/__whoami`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return { kind: 'other' };
        const info = await r.json();
        return info && info.standard === STANDARD ? { kind: 'standard', info } : { kind: 'other' };
    } catch (err) {
        const code = err && (err.code || (err.cause && err.cause.code));
        return err && (err.name === 'TimeoutError' || code === 'ECONNRESET') ? { kind: 'other' } : { kind: 'free' };
    }
}

function startServer() {
    const log = path.join(app.getPath('userData'), 'logs', 'server.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, 'a');
    child = spawn(process.execPath, [SERVER, '--serve'], {
        cwd: ROOT, stdio: ['ignore', fd, fd], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    fs.closeSync(fd);
    slog(`server spawned pid ${child.pid}`);
    child.on('exit', (code) => {
        slog(`server exited (${code})`);
        child = null;
        if (!quitting) { setState('error', 'server stopped'); }
    });
}

const samePath = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function ensureServer() {
    const found = await whoami();
    if (found.kind === 'standard' && found.info.app === APP) {
        // only this Engram's own server is reused: one from another folder (a
        // checkout, a preview) would show another memory as if it were this one (D-A977)
        if (!samePath(found.info.root, ROOT)) {
            setState('error', `port ${PORT} is serving Engram from ${found.info.root}. Quit that one first.`);
            slog(`refusing to reuse server pid ${found.info.pid} at ${found.info.root}; this Engram is ${ROOT}`);
            return false;
        }
        slog(`reusing server pid ${found.info.pid} at ${found.info.root}`);
        return true;
    }
    if (found.kind === 'free') {
        startServer();
        for (let i = 0; i < 50; i++) {
            await new Promise((r) => setTimeout(r, 120));
            const again = await whoami();
            if (again.kind === 'standard' && again.info.app === APP) return true;
        }
        setState('error', `server did not answer on port ${PORT}`);
        return false;
    }
    setState('error', `port ${PORT} is held by something else. Refusing to fight for it.`);
    return false;
}

/**
 * The first run of an installed Engram starts empty (D-A977): whatever
 * memory an earlier checkout or preview left selected in the config is
 * forgotten (the folder itself is untouched), so Setup is the first thing
 * the person sees. A marker in the config folder makes this happen once;
 * an upgrade keeps the person's memory.
 */
function firstRun() {
    if (!app.isPackaged) return false;
    const dir = app.getPath('userData');
    const marker = path.join(dir, 'installed.json');
    if (fs.existsSync(marker)) return false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const cfgFile = path.join(dir, 'config.json');
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { cfg = {}; }
        const had = cfg.repository || null;
        delete cfg.repository;
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        fs.writeFileSync(marker, JSON.stringify({ version: app.getVersion(), at: new Date().toISOString(), forgot: had }, null, 2) + '\n', 'utf8');
        slog(`first run of an installed Engram: selection cleared (was ${had || 'none'}); Setup is first`);
    } catch (err) {
        slog(`first run: could not clear the selection: ${err.message}`);
    }
    return true;
}

// ------------------------------------------------------------ the state ---

function setState(next, text) {
    state = next;
    if (text) status = { ...status, text };
    if (!tray) return;
    const file = path.join(ICONS, `${next}.png`);
    if (fs.existsSync(file)) tray.setImage(nativeImage.createFromPath(file));
    else { const ico = windowIcon(); if (ico) tray.setImage(ico); slog(`state icon missing: ${file}`); }
    tray.setToolTip(`Engram: ${status.text}`);
    refreshMenu();
}

function pulse() {
    if (!tray) return;
    const file = path.join(ICONS, 'listening.png');
    if (fs.existsSync(file)) tray.setImage(nativeImage.createFromPath(file));
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => setState(state), 1200);
}

async function refreshStatus() {
    try {
        const r = await fetch(`${URL_ROOT}/api/status`, { signal: AbortSignal.timeout(1500) });
        const s = await r.json();
        if (!s.repository) { status = { text: s.error || 'no memory selected' }; return setState('error'); }
        status = { text: `${s.stats.engrams} engrams · ${s.stats.containers} containers · ${path.basename(s.repository)}`, repository: s.repository };
        if (s.contradictions > 0 || (s.rulesInstalled && s.rulesInstalled !== s.rulesVersion)) return setState('attention');
        if (s.sessionsActive > 0) return setState('listening');
        return setState('idle');
    } catch {
        status = { text: 'server not answering' };
        setState('error');
    }
}

/** Listen to the live stream so an engram landing pulses the icon within a second. */
function listen() {
    if (live) { try { live.destroy(); } catch { /* gone */ } live = null; }
    const req = http.get(`${URL_ROOT}/api/live`, (res) => {
        let buf = '';
        res.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                const line = chunk.split('\n').find((l) => l.startsWith('data: '));
                if (!line) continue;
                try {
                    const ev = JSON.parse(line.slice(6));
                    if (ev.type === 'engram' || ev.type === 'artefact' || ev.type === 'change') { slog('pulse: ' + ev.type + ' ' + (ev.id || ev.file || '')); pulse(); setTimeout(refreshStatus, 1500); }
                    if (ev.type === 'memory') refreshStatus();
                } catch { /* a torn event is skipped */ }
            }
        });
        res.on('end', () => { live = null; setTimeout(listen, 3000); });
        res.on('error', () => { live = null; setTimeout(listen, 3000); });
    });
    req.on('error', () => { live = null; setTimeout(listen, 5000); });
    live = req;
}

// ---------------------------------------------------------------- windows ---

function windowIcon() {
    const ico = path.join(ROOT, 'assets', 'engram.ico');
    return fs.existsSync(ico) ? nativeImage.createFromPath(ico) : undefined;
}

/** The one window, on Search, the box focused. A normal window (D-A981, D-A982); no hotkey, no popup. */
function openSearch() {
    openMain('search');
}

/** One click on the tray icon: show the window where it was, or open it on Live. */
function showMain() {
    if (main && !main.isDestroyed()) { main.show(); main.focus(); return; }
    openMain('live');
}

function openMain(route) {
    if (main && !main.isDestroyed()) {
        // the page is already up: move it by hash so its own history and state stay
        main.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}; if (${JSON.stringify(route)} === 'search') { const q = document.getElementById('q'); if (q) { q.focus(); q.select(); } }`).catch(() => {});
        if (main.isMinimized()) main.restore();
        main.show(); main.focus();
        return;
    }
    main = new BrowserWindow({ width: 1240, height: 800, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#0f1218', title: 'Engram', icon: windowIcon(), autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
    main.loadURL(`${URL_ROOT}/#${route}`);
    main.once('ready-to-show', () => { main.show(); });
    // The window stays open until the person minimises it; minimise (and the
    // close button) put it back in the tray, one click on the icon brings it
    // back where it was (D-A983). Quit is the tray menu's alone.
    main.on('minimize', (ev) => { ev.preventDefault(); main.hide(); });
    main.on('close', (ev) => { if (!quitting) { ev.preventDefault(); main.hide(); } });
    main.on('closed', () => { main = null; });
    main.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ------------------------------------------------------------------ tray ---

function menu() {
    return Menu.buildFromTemplate([
        { label: 'Search', click: openSearch },
        { label: 'Open Engram', click: () => openMain('live') },
        { type: 'separator' },
        { label: 'Live', click: () => openMain('live') },
        { label: 'Add a memory', click: () => openMain('add') },
        { label: 'Setup', click: () => openMain('setup') },
        { label: status.text, enabled: false },
        { type: 'separator' },
        { label: 'Start with Windows', type: 'checkbox', checked: autostart.current(), click: (item) => autostart.setEnabled(item.checked, refreshMenu) },
        { label: 'Show logs', click: () => shell.openPath(path.dirname(logFile())) },
        { type: 'separator' },
        { label: 'Quit Engram', click: () => app.quit() },
    ]);
}

function refreshMenu() {
    if (tray) tray.setContextMenu(menu());
}

// ------------------------------------------------------------------ boot ---

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showMain);
    app.whenReady().then(async () => {
        // never an empty image: an invisible tray icon is a missing app (D-A978)
        const first = path.join(ICONS, 'error.png');
        tray = new Tray(fs.existsSync(first) ? nativeImage.createFromPath(first) : (windowIcon() || nativeImage.createEmpty()));
        tray.setToolTip('Engram');
        tray.setContextMenu(menu());
        tray.on('click', showMain);
        tray.on('double-click', showMain);
        autostart.load(app, refreshMenu);
        const fresh = firstRun();
        slog(`userData ${app.getPath('userData')}; APPDATA ${process.env.APPDATA || '(unset)'}; started from ${process.cwd()}`);
        const up = await ensureServer();
        if (up) { await refreshStatus(); listen(); if (fresh) openMain('setup'); }
        setInterval(async () => {
            if (quitting) return;
            const found = await whoami();
            if (found.kind === 'free') {
                slog('server gone; restarting it');
                if (await ensureServer()) { refreshStatus(); listen(); }
            } else refreshStatus();
        }, 15000);
        slog('tray ready');
    });
    app.on('before-quit', async (ev) => {
        if (quitting) return;
        quitting = true;
        ev.preventDefault();
        globalShortcut.unregisterAll();
        if (child) {
            try { await fetch(`${URL_ROOT}/__stop`, { signal: AbortSignal.timeout(1000) }); } catch { /* it may drop the socket as it exits */ }
            await new Promise((r) => setTimeout(r, 300));
            if (child) { try { child.kill(); } catch { /* already gone */ } }
        }
        slog('quit');
        app.exit(0);
    });
    app.on('window-all-closed', () => { /* the tray is the app */ });
}
