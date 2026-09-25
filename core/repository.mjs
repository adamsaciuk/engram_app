// ENGRAM core: the memory repository. A memory is one folder on this
// computer, the one the person picked at setup, and this module is the
// only thing that knows its layout:
//
//   <repository>/
//     ENGRAM.md, CLAUDE.md               the rules as installed (see rules.mjs)
//     cortex/<Title>.md                  the root map (derived; named after the memory)
//     cortex/<container>/<Title>.md      a container's map (derived; named after the region)
//     cortex/<container>/<title>.md      one engram, named by its title: Echo first, engram beneath;
//                                        the id is an alias, so [[id]] links resolve
//     cortex/<container>/<sub>/...       sub containers, any depth
//     artefacts/<id>.md                  "this was produced" records (bytes never here)
//     devices/<device>.json              one per device, written by that device
//     sessions/<device>/<id>.json        one per session, written by its device
//     traces/<device>/<date>.jsonl       recall traces, append-only, per device
//     ledger/<device>/<date>.json        tokens, bytes, dollars per action
//     settings.json                      long-term storage endpoint and budgets
//     .engram/                           caches the tool rebuilds at will
//
// Every map is derived from the engrams by a rebuild. An engram body is
// immutable to the AI: the tool maintains only its address and its
// back-links. The person may edit their own memory (editEngram); the note
// then carries an edited stamp. Nothing is ever deleted (D-A736).

import { randomBytes } from 'node:crypto';
import {
    existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, appendFileSync, renameSync, unlinkSync, openSync, readSync, closeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { slug, uniqueTerms, firstLine } from './text.mjs';
import { renderFrontMatter, parseNote, wiki, unwiki, quote, unquote, sections } from './note.mjs';

export const PRODUCT = 'Engram';
export const LAYOUT_VERSION = 2;
export const LEGACY_MAP_NOTE = '_map.md';

/** A file name Windows accepts: no path or link characters, trimmed, capped. */
export function safeName(text, max = 60) {
    const s = String(text || '').replace(/[<>:"/\\|?*#^\[\]\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/, '').trim();
    const cut = s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '').trim() : s;
    return cut || 'untitled';
}

export const KINDS = ['action', 'decision', 'learning', 'artefact', 'recommendation', 'consolidation', 'digest', 'move', 'genesis'];
/** Kinds that record the memory's own structure: never vocabulary, never recall candidates. */
export const STRUCTURAL = new Set(['digest', 'move', 'genesis']);
export const LINK_KINDS = ['cites', 'supersedes', 'refines', 'confirms', 'contradicts', 'produced_from', 'consolidates'];
export const BACK_OF = { cites: 'cited_by', supersedes: 'superseded_by', refines: 'refined_by', confirms: 'confirmed_by', contradicts: 'contradicted_by', produced_from: 'produced', consolidates: 'consolidated_by' };
export const BACK_KINDS = Object.values(BACK_OF);

// ------------------------------------------------------------- config ---

/** Per-user, per-device product config: which memory is active, which device this is. */
let migrated = false;
export function configDir() {
    // Per machine, under the user's real profile: on Windows Local AppData
    // (the repository path, the device and the keys are all per machine, and
    // a sandboxed launcher was seen unable to read Roaming). The APPDATA
    // variable is not trusted. ENGRAM_CONFIG_DIR overrides, for tests.
    if (process.env.ENGRAM_CONFIG_DIR) return process.env.ENGRAM_CONFIG_DIR;
    const dir = process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', PRODUCT) : join(homedir(), '.config', PRODUCT);
    if (!migrated && process.platform === 'win32') {
        migrated = true;
        // one-time move from the earlier Roaming location
        const old = join(homedir(), 'AppData', 'Roaming', PRODUCT);
        try {
            if (!existsSync(join(dir, 'config.json')) && existsSync(join(old, 'config.json'))) {
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'config.json'), readFileSync(join(old, 'config.json')));
                if (existsSync(join(old, 'keys'))) {
                    mkdirSync(join(dir, 'keys'), { recursive: true });
                    for (const f of readdirSync(join(old, 'keys'))) if (!existsSync(join(dir, 'keys', f))) writeFileSync(join(dir, 'keys', f), readFileSync(join(old, 'keys', f)));
                }
            }
        } catch { /* the old location is optional */ }
    }
    return dir;
}

export function configPath() {
    return join(configDir(), 'config.json');
}

export function readConfig() {
    try {
        return JSON.parse(readFileSync(configPath(), 'utf8'));
    } catch {
        return {};
    }
}

export function writeConfig(patch) {
    mkdirSync(configDir(), { recursive: true });
    const merged = { ...readConfig(), ...patch };
    writeJson(configPath(), merged);
    return merged;
}

/** This device's identity, minted once and kept in the config. */
export function thisDevice() {
    const cfg = readConfig();
    if (cfg.device && cfg.device.id) return cfg.device;
    const device = { id: slug(hostname()) || 'device-' + randomBytes(3).toString('hex'), name: hostname(), os: process.platform };
    writeConfig({ device });
    return device;
}

/**
 * Which memory a command works on: --repo <path>, then ENGRAM_REPO, then
 * the config. Throws a plain error when there is none, because guessing a
 * memory is worse than asking.
 */
export function resolveRepoPath(explicit) {
    const p = explicit || process.env.ENGRAM_REPO || readConfig().repository;
    if (!p) {
        throw new Error(`no memory selected (no repository in ${configPath()}). Open Setup and pick a folder, or run "engram setup <folder>" or "engram use <dir>".`);
    }
    return resolve(p);
}

// ----------------------------------------------------------------- ids ---

/**
 * Ids are machine identifiers: time-ordered so files sort by when they were
 * written, random-suffixed so two devices offline never collide, never
 * shown to a person as a name.
 */
export function mintId(now = Date.now()) {
    return now.toString(36).padStart(9, '0') + '-' + randomBytes(4).toString('hex');
}

export function nowIso() {
    return new Date().toISOString();
}

// -------------------------------------------------------------- helpers ---

export function readJson(path, fallback) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return fallback;
    }
}

/** Atomic write: temp file then rename, so a crash never leaves half a file. */
export function writeJson(path, value) {
    writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(path, text) {
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = path + '.tmp-' + process.pid;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, path);
}

/** Validate and normalise a container path: 'a/b/c', '' is the root. */
export function normalizeContainerPath(p) {
    const raw = String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!raw) return '';
    const parts = raw.split('/').map(slug).filter(Boolean);
    if (!parts.length) return '';
    return parts.join('/');
}

// ---------------------------------------------------------- the engram ---

/** An engram's note text: front matter, title, Echo, then the engram itself. */
export function renderEngram(e) {
    const fm = {
        id: e.id,
        aliases: [e.id],
        kind: e.kind,
        when: e.when,
        device: e.device,
        session: e.session || '',
        container: e.container,
        tags: e.tags || [],
    };
    if (!fm.session) delete fm.session;
    if (e.edited) fm.edited = e.edited;
    // empty link lists are left out so a note's properties stay readable in Obsidian
    for (const k of LINK_KINDS) { const v = (e.links || []).filter((l) => l.kind === k).map((l) => wiki(l.id)); if (v.length) fm[k] = v; }
    for (const k of BACK_KINDS) { const v = ((e.back || {})[k] || []).map(wiki); if (v.length) fm[k] = v; }
    if (e.artefacts && e.artefacts.length) fm.artefacts = e.artefacts.map((a) => wiki(a.id));
    const L = [renderFrontMatter(fm)];
    L.push(`# ${e.title || firstLine(e.echo, 80) || e.kind}`);
    L.push('');
    L.push('## Echo');
    L.push(e.echo || '');
    L.push('');
    L.push('## Engram');
    L.push('**Stimulus** (verbatim)');
    L.push(quote(e.stimulus));
    if (e.done) { L.push(''); L.push('**Done**'); L.push(e.done); }
    if (e.decision) { L.push(''); L.push('**Decision**'); L.push(e.decision); }
    if (e.artefacts && e.artefacts.length) {
        L.push(''); L.push('**Artefacts**');
        for (const a of e.artefacts) L.push(`- ${wiki(a.id)}${a.name ? ' ' + a.name : ''}`);
    }
    if (e.links && e.links.length) {
        L.push(''); L.push('**Links**');
        for (const l of e.links) L.push(`- ${l.kind} ${wiki(l.id)}${l.why ? ': ' + l.why : ''}`);
    }
    L.push('');
    return L.join('\n');
}

/** Parse an engram note back into the object renderEngram wrote. */
export function parseEngram(text) {
    const { fields: f, body } = parseNote(text);
    if (!f.id) return null;
    const title = (body.match(/^# (.*)$/m) || [])[1] || '';
    const echoStart = body.indexOf('## Echo');
    const engramStart = body.indexOf('## Engram');
    const echo = echoStart >= 0 ? body.slice(echoStart + 7, engramStart >= 0 ? engramStart : undefined).trim() : '';
    const rest = engramStart >= 0 ? body.slice(engramStart + 9) : '';
    const sec = sections(rest, ['Stimulus', 'Done', 'Decision', 'Artefacts', 'Links']);
    const stimulus = unquote((sec.Stimulus || '').replace(/^\s*\(verbatim\)\s*\n?/, ''));
    const links = [];
    for (const line of (sec.Links || '').split('\n')) {
        const m = line.match(/^-\s+(\w+)\s+\[\[([^\]|]+)(?:\|[^\]]*)?\]\](?::\s*(.*))?$/);
        if (m) links.push({ kind: m[1], id: m[2].trim(), why: (m[3] || '').trim() });
    }
    if (!links.length) for (const k of LINK_KINDS) for (const w of f[k] || []) links.push({ kind: k, id: unwiki(w), why: '' });
    const artefacts = [];
    for (const line of (sec.Artefacts || '').split('\n')) {
        const m = line.match(/^-\s+\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*(.*)$/);
        if (m) artefacts.push({ id: m[1].trim(), name: (m[2] || '').trim() });
    }
    const back = {};
    for (const k of BACK_KINDS) back[k] = (f[k] || []).map(unwiki);
    return {
        id: String(f.id), kind: String(f.kind || 'action'), when: String(f.when || ''), device: String(f.device || ''),
        session: String(f.session || ''), container: normalizeContainerPath(f.container || ''), tags: (f.tags || []).map(String),
        links, back, artefacts, title, echo, stimulus, done: sec.Done || '', decision: sec.Decision || '', edited: f.edited ? String(f.edited) : '',
    };
}

/** Text of an engram for vocabulary and scoring: the Echo weighs most, then the rest. */
export function engramText(e) {
    return [e.echo, e.echo, e.stimulus, e.done, e.decision, ...(e.tags || [])].filter(Boolean).join('\n');
}

/** One-line label for an engram. */
export function engramLine(e) {
    const head = e.kind === 'decision' && e.decision ? e.decision : e.title || e.echo || e.stimulus || '';
    return `${e.kind}: ${firstLine(head, 100)}`;
}

// --------------------------------------------------------- the artefact ---

export function renderArtefact(a) {
    const fm = { id: a.id, type: 'artefact', engram: wiki(a.engram), container: a.container, name: a.name, device: a.device, size: a.size, hash: a.hash, availability: a.availability, banked: a.banked || '', objectKey: a.objectKey || '', bankedBy: a.bankedBy || '', when: a.when };
    const L = [renderFrontMatter(fm)];
    L.push(`# ${a.name}`);
    L.push('');
    L.push(`Produced by ${wiki(a.engram)} in ${a.container || 'root'} on ${a.device}, ${a.when}.`);
    L.push('');
    L.push(`**Path** ${a.path}`);
    L.push(`**Availability** ${a.availability}${a.banked ? ', banked ' + a.banked : ''}`);
    if (a.note) { L.push(''); L.push('**Note**'); L.push(a.note); }
    L.push('');
    return L.join('\n');
}

export function parseArtefact(text) {
    const { fields: f, body } = parseNote(text);
    if (!f.id || f.type !== 'artefact') return null;
    const path = (body.match(/^\*\*Path\*\* (.*)$/m) || [])[1] || '';
    const note = (sections(body, ['Note']).Note || '');
    return { id: String(f.id), engram: unwiki(f.engram), container: normalizeContainerPath(f.container || ''), name: String(f.name || ''), device: String(f.device || ''), size: Number(f.size || 0), hash: String(f.hash || ''), availability: String(f.availability || 'device'), banked: f.banked ? String(f.banked) : null, objectKey: f.objectKey ? String(f.objectKey) : '', bankedBy: f.bankedBy ? String(f.bankedBy) : '', when: String(f.when || ''), path, note };
}

// ------------------------------------------------------------ repository ---

export class Repository {
    constructor(root) {
        this.root = resolve(root);
        this.cortex = join(this.root, 'cortex');
        this.artefactsDir = join(this.root, 'artefacts');
        this.devicesDir = join(this.root, 'devices');
        this.sessionsDir = join(this.root, 'sessions');
        this.tracesDir = join(this.root, 'traces');
        this.ledgerDir = join(this.root, 'ledger');
        this.localDir = join(this.root, '.engram');
        this._engramCache = null;
    }

    exists() {
        return existsSync(this.cortex) && statSync(this.cortex).isDirectory();
    }

    /** Create the directory skeleton (idempotent). Files come from init in engram.mjs/rules.mjs. */
    scaffold() {
        for (const d of [this.cortex, this.artefactsDir, this.devicesDir, this.sessionsDir, this.tracesDir, this.ledgerDir, this.localDir]) {
            mkdirSync(d, { recursive: true });
        }
    }

    settings() {
        return readJson(join(this.root, 'settings.json'), {});
    }

    writeSettings(patch) {
        const next = { ...this.settings(), ...patch };
        writeJson(join(this.root, 'settings.json'), next);
        return next;
    }

    // containers

    containerDir(path) {
        const p = normalizeContainerPath(path);
        const dir = p ? join(this.cortex, ...p.split('/')) : this.cortex;
        if (dir !== this.cortex && !dir.startsWith(this.cortex + sep)) throw new Error('container path escapes the cortex');
        return dir;
    }

    hasContainer(path) {
        const p = normalizeContainerPath(path);
        if (!p) return existsSync(this.cortex);
        return existsSync(this.containerDir(p)) && statSync(this.containerDir(p)).isDirectory();
    }

    /** Immediate sub containers of a path. */
    children(path) {
        const dir = this.containerDir(path);
        if (!existsSync(dir)) return [];
        const p = normalizeContainerPath(path);
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => (p ? p + '/' + e.name : e.name))
            .sort();
    }

    /** Every container path, root first, depth-first. */
    listContainers() {
        const out = [''];
        const walk = (p) => {
            for (const c of this.children(p)) {
                out.push(c);
                walk(c);
            }
        };
        walk('');
        return out;
    }

    parentOf(path) {
        const p = normalizeContainerPath(path);
        if (!p) return null;
        const i = p.lastIndexOf('/');
        return i < 0 ? '' : p.slice(0, i);
    }

    ancestors(path) {
        const out = [];
        let p = normalizeContainerPath(path);
        while (p) { p = this.parentOf(p); out.push(p); }
        return out;
    }

    /** Open a container directory (and any missing ancestors). The map is written by the rebuild. */
    openContainer(path) {
        const p = normalizeContainerPath(path);
        if (!p) return '';
        mkdirSync(this.containerDir(p), { recursive: true });
        return p;
    }

    /** Titles are kept in a small local-free file per container so a rename never touches engrams. */
    readTitle(path) {
        const p = normalizeContainerPath(path);
        const t = readJson(join(this.containerDir(p), '.title.json'), null);
        return (t && t.title) || (p ? p.split('/').pop() : 'root');
    }

    writeTitle(path, title) {
        const p = normalizeContainerPath(path);
        if (title) writeJson(join(this.containerDir(p), '.title.json'), { title });
    }

    /** The map note is named after its region (the root after the memory), so the graph reads. */
    mapFile(path) {
        const p = normalizeContainerPath(path);
        return safeName(p ? this.readTitle(p) : (this.readTitle('') !== 'root' ? this.readTitle('') : 'Cortex')) + '.md';
    }

    mapPath(path) {
        return join(this.containerDir(path), this.mapFile(path));
    }

    /** The map's path from the vault root, for wikilinks: cortex/<container>/<Title>. */
    mapLink(path) {
        const p = normalizeContainerPath(path);
        return ['cortex', ...(p ? p.split('/') : []), this.mapFile(p).replace(/\.md$/, '')].join('/');
    }

    isMapNote(file) {
        try {
            const fd = openSync(file, 'r');
            const buf = Buffer.alloc(64);
            const n = readSync(fd, buf, 0, 64, 0);
            closeSync(fd);
            return /^---\r?\ntype: map/.test(buf.subarray(0, n).toString('utf8'));
        } catch {
            return false;
        }
    }

    /** Write the map and remove any earlier map note in the folder (the legacy _map.md, or an old title). */
    writeMapNote(path, text) {
        const p = normalizeContainerPath(path);
        const file = this.mapPath(p);
        const dir = this.containerDir(p);
        if (existsSync(file) && !this.isMapNote(file)) {
            // an engram written before this guard carries the region's own name: it yields to the map
            const e = this._readEngramFile(file, p);
            if (e) { renameSync(file, join(dir, this._engramFileName(dir, e))); this._engramCache = {}; this._cacheDirty = true; this.rebuildIdmap(); this.saveCache(); }
        }
        writeText(file, text);
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.md') || f === basename(file)) continue;
            if (f === LEGACY_MAP_NOTE || this.isMapNote(join(dir, f))) { try { unlinkSync(join(dir, f)); } catch { /* fine */ } }
        }
    }

    // engrams

    /** Where an engram's note is, through the id map (an engram is named by its title, not its id). */
    engramPath(container, id) {
        const entry = this._idmap()[id];
        if (entry && typeof entry === 'object' && entry.f) return join(this.containerDir(entry.c), entry.f);
        if (typeof entry === 'string') return join(this.containerDir(entry), id + '.md');
        return join(this.containerDir(container), id + '.md');
    }

    /** The note's path from the vault root, for links and for opening in Obsidian. */
    engramFile(id) {
        const entry = this._idmap()[id];
        if (!entry) return null;
        const c = typeof entry === 'string' ? entry : entry.c;
        const f = typeof entry === 'string' ? id + '.md' : entry.f;
        return ['cortex', ...(c ? c.split('/') : []), f].join('/');
    }

    /** The file name a new engram gets: its title, unique within the folder. */
    _engramFileName(dir, e) {
        const base = safeName(e.title || firstLine(e.echo, 80) || e.kind);
        const mapName = this.mapFile(e.container || '').toLowerCase();
        const taken = (n) => n.toLowerCase() === mapName || existsSync(join(dir, n));
        let name = base + '.md';
        for (let n = 2; taken(name); n++) name = base + ' ~' + n + '.md';
        return name;
    }

    /** Engrams written directly in one container, oldest first (by id, which is time-ordered). */
    listEngrams(path) {
        const dir = this.containerDir(path);
        if (!existsSync(dir)) return [];
        const p = normalizeContainerPath(path);
        return readdirSync(dir)
            .filter((f) => f.endsWith('.md') && f !== LEGACY_MAP_NOTE && !f.startsWith('.'))
            .map((f) => this._readEngramFile(join(dir, f), p))
            .filter(Boolean)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    _readEngramFile(file, container) {
        const key = file;
        const st = statSync(file);
        const cache = this._cache();
        const hit = cache[key];
        if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return { ...hit.engram, container };
        const text = readFileSync(file, 'utf8');
        if (/^---\r?\ntype: map/.test(text)) return null;
        const e = parseEngram(text);
        if (!e) return null;
        e.container = container;
        cache[key] = { mtime: st.mtimeMs, size: st.size, engram: e };
        this._cacheDirty = true;
        return e;
    }

    _cache() {
        if (!this._engramCache) this._engramCache = readJson(join(this.localDir, 'engrams.json'), {});
        return this._engramCache;
    }

    saveCache() {
        if (this._cacheDirty) { writeJson(join(this.localDir, 'engrams.json'), this._engramCache || {}); this._cacheDirty = false; }
    }

    /** Engrams in a container and everything beneath it. */
    listEngramsDeep(path) {
        const p = normalizeContainerPath(path);
        const out = [...this.listEngrams(p)];
        for (const c of this.children(p)) out.push(...this.listEngramsDeep(c));
        return out;
    }

    allEngrams() {
        const all = this.listEngramsDeep('');
        this.saveCache();
        return all;
    }

    writeEngram(engram) {
        const dir = this.containerDir(engram.container);
        mkdirSync(dir, { recursive: true });
        if (this._idmap()[engram.id]) throw new Error(`engram ${engram.id} already exists and engrams are immutable`);
        const name = this._engramFileName(dir, engram);
        writeText(join(dir, name), renderEngram(engram));
        this._idmap()[engram.id] = { c: engram.container, f: name };
        this._saveIdmap();
        return engram;
    }

    /** Rewrite only the tool-maintained header of an engram (address, back-links). The body never changes. */
    rewriteEngramHeader(engram) {
        const file = this.engramPath(engram.container, engram.id);
        const current = readFileSync(file, 'utf8');
        const next = renderEngram(engram);
        if (current !== next) {
            const before = parseEngram(current);
            const after = parseEngram(next);
            if (before.stimulus !== after.stimulus || before.echo !== after.echo || before.done !== after.done || before.decision !== after.decision) {
                throw new Error(`refusing to rewrite the body of engram ${engram.id}`);
            }
            writeText(file, next);
        }
    }

    /**
     * The person's edit of their own memory: the body may change, the id,
     * kind, time and device never do. The note is renamed when its name
     * changed and stamped with when it was edited. The caller rebuilds.
     */
    editEngram(engram) {
        const entry = this._idmap()[engram.id];
        if (!entry) throw new Error(`engram ${engram.id} is not in this memory`);
        const c = typeof entry === 'string' ? entry : entry.c;
        const oldFile = this.engramPath(c, engram.id);
        const dir = this.containerDir(c);
        const next = { ...engram, container: c };
        let name = typeof entry === 'string' ? engram.id + '.md' : entry.f;
        const wanted = safeName(next.title || firstLine(next.echo, 80) || next.kind) + '.md';
        if (wanted.toLowerCase() !== name.toLowerCase()) {
            const fresh = this._engramFileName(dir, next);
            renameSync(oldFile, join(dir, fresh));
            delete this._cache()[oldFile];
            name = fresh;
        }
        writeText(join(dir, name), renderEngram(next));
        this._idmap()[engram.id] = { c, f: name };
        this._saveIdmap();
        this._cacheDirty = true;
        return next;
    }

    /** Find one engram by id, via the local id map (rebuilt by walking when stale). */
    findEngram(id) {
        let entry = this._idmap()[id];
        let file = entry ? this.engramPath(typeof entry === 'string' ? entry : entry.c, id) : null;
        if (!file || !existsSync(file)) {
            this.rebuildIdmap();
            entry = this._idmap()[id];
            if (!entry) return null;
            file = this.engramPath(typeof entry === 'string' ? entry : entry.c, id);
        }
        return this._readEngramFile(file, typeof entry === 'string' ? entry : entry.c);
    }

    rebuildIdmap() {
        const map = {};
        for (const c of this.listContainers()) {
            const dir = this.containerDir(c);
            for (const f of readdirSync(dir)) {
                if (!f.endsWith('.md') || f === LEGACY_MAP_NOTE || f.startsWith('.')) continue;
                const e = this._readEngramFile(join(dir, f), c);
                if (e) map[e.id] = { c, f };
            }
        }
        this._idmapCache = map;
        this._saveIdmap();
        return map;
    }

    /**
     * Give every engram still named by its id (the first layout) its title
     * as a file name. Bodies untouched; the id stays as an alias. Returns
     * how many files moved.
     */
    renameLegacyEngrams() {
        let moved = 0;
        for (const c of this.listContainers()) {
            const dir = this.containerDir(c);
            for (const f of readdirSync(dir)) {
                if (!/^[0-9a-z]{9}-[0-9a-f]{8}\.md$/.test(f)) continue;
                const e = this._readEngramFile(join(dir, f), c);
                if (!e || e.id + '.md' !== f) continue;
                const name = this._engramFileName(dir, e);
                renameSync(join(dir, f), join(dir, name));
                moved++;
            }
        }
        if (moved) { this._engramCache = {}; this._cacheDirty = true; this.rebuildIdmap(); this.saveCache(); }
        return moved;
    }

    _idmap() {
        if (!this._idmapCache) this._idmapCache = readJson(join(this.localDir, 'idmap.json'), null) || this.rebuildIdmap();
        return this._idmapCache;
    }

    _saveIdmap() {
        mkdirSync(this.localDir, { recursive: true });
        writeJson(join(this.localDir, 'idmap.json'), this._idmapCache || {});
    }

    /**
     * Move a container under a new parent path (a filing act: engrams do not
     * change, only their address). The caller records the move as an engram.
     */
    moveContainer(from, toParent) {
        const f = normalizeContainerPath(from);
        const tp = normalizeContainerPath(toParent);
        if (!f) throw new Error('the root cannot be moved');
        if (!this.hasContainer(f)) throw new Error(`no container "${f}"`);
        if (tp && !this.hasContainer(tp)) throw new Error(`no container "${tp}" to move under`);
        const name = f.split('/').pop();
        const dest = tp ? tp + '/' + name : name;
        if (dest === f) return f;
        if (dest.startsWith(f + '/')) throw new Error('a container cannot be moved beneath itself');
        if (this.hasContainer(dest)) throw new Error(`a container "${dest}" already exists`);
        renameSync(this.containerDir(f), this.containerDir(dest));
        this._engramCache = {};
        this._cacheDirty = true;
        this.rebuildIdmap();
        const fix = (p) => {
            for (const e of this.listEngrams(p)) if (e.container !== p) this.rewriteEngramHeader({ ...e, container: p });
            for (const c of this.children(p)) fix(c);
        };
        fix(dest);
        this.rebuildIdmap();
        this.saveCache();
        return dest;
    }

    // artefacts

    writeArtefact(record) {
        writeText(join(this.artefactsDir, record.id + '.md'), renderArtefact(record));
        return record;
    }

    listArtefacts() {
        if (!existsSync(this.artefactsDir)) return [];
        return readdirSync(this.artefactsDir)
            .filter((f) => f.endsWith('.md'))
            .sort()
            .map((f) => parseArtefact(readFileSync(join(this.artefactsDir, f), 'utf8')))
            .filter(Boolean);
    }

    findArtefact(id) {
        const file = join(this.artefactsDir, id + '.md');
        return existsSync(file) ? parseArtefact(readFileSync(file, 'utf8')) : null;
    }

    // devices

    writeDevice(device) {
        const existing = readJson(join(this.devicesDir, device.id + '.json'), {});
        writeJson(join(this.devicesDir, device.id + '.json'), { ...existing, ...device, lastSeen: nowIso() });
    }

    listDevices() {
        if (!existsSync(this.devicesDir)) return [];
        return readdirSync(this.devicesDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => readJson(join(this.devicesDir, f), null))
            .filter(Boolean);
    }

    // sessions (one file per session, written by its own device only)

    sessionPath(deviceId, id) {
        return join(this.sessionsDir, deviceId, id + '.json');
    }

    writeSession(session) {
        writeJson(this.sessionPath(session.device, session.id), session);
        return session;
    }

    readSession(deviceId, id) {
        return readJson(this.sessionPath(deviceId, id), null);
    }

    listSessions(deviceId) {
        const out = [];
        if (!existsSync(this.sessionsDir)) return out;
        const devices = deviceId ? [deviceId] : readdirSync(this.sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        for (const d of devices) {
            const dir = join(this.sessionsDir, d);
            if (!existsSync(dir)) continue;
            for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
                const s = readJson(join(dir, f), null);
                if (s) out.push(s);
            }
        }
        return out.sort((a, b) => (a.started < b.started ? 1 : -1));
    }

    // traces (per device, append-only)

    appendTrace(deviceId, trace) {
        const day = (trace.when || nowIso()).slice(0, 10);
        const dir = join(this.tracesDir, deviceId);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, day + '.jsonl'), JSON.stringify(trace) + '\n', 'utf8');
    }

    /** Traces from every device, most recent N day-files per device. */
    readTraces(days = 90) {
        if (!existsSync(this.tracesDir)) return [];
        const out = [];
        for (const d of readdirSync(this.tracesDir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const dir = join(this.tracesDir, d.name);
            const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(-days);
            for (const f of files) {
                for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try { out.push(JSON.parse(line)); } catch { /* a torn line is skipped, never fatal */ }
                }
            }
        }
        return out;
    }

    // ledger (per device)

    appendLedger(deviceId, entry) {
        const day = (entry.when || nowIso()).slice(0, 10);
        const file = join(this.ledgerDir, deviceId, day + '.json');
        const list = readJson(file, []);
        list.push(entry);
        writeJson(file, list);
    }

    /** A cheap size summary for status lines. */
    stats() {
        const containers = this.listContainers();
        let engrams = 0;
        let decisions = 0;
        for (const c of containers) for (const e of this.listEngrams(c)) { engrams++; if (e.kind === 'decision') decisions++; }
        this.saveCache();
        return { containers: containers.length - 1, engrams, decisions, artefacts: this.listArtefacts().length, devices: this.listDevices().length };
    }

    fileMtime(path) {
        try { return statSync(path).mtime.toISOString(); } catch { return null; }
    }
}

export { uniqueTerms };
