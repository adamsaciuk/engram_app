// ENGRAM core: long-term storage (D-A735). Text is memory and lives in
// git; bytes are artefacts and live on the device that made them, and,
// only on the person's explicit word, in an S3-compatible store. Recall
// reads the artefact records, never the bucket. Fetch is a deliberate,
// budgeted, recorded act.
//
// Rules the code enforces, not the prompt:
//   bank   refused without --by-user (D-A738, D-A740): the AI may
//          recommend, never bank
//   fetch  needs a stated reason; per-session and per-device-per-day
//          budgets from settings.json; over budget the tool refuses and
//          prints what it would have cost; cache before bucket
//   keys   one scoped key per device in the product key store, never in
//          the repository; a Key Vault pack or a plain JSON file is the
//          input
//   client plain Node: Signature Version 4 from node:crypto, no SDK ships

import { createHash, createHmac } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { nowIso, thisDevice } from './repository.mjs';
import { storeSecret, loadSecret, hasSecret } from './secrets.mjs';
import { resolveSession, touchSession } from './session.mjs';
import { engram } from './engram.mjs';

export const DEFAULT_BUDGETS = { objectReasonMB: 50, sessionMB: 500, deviceDayMB: 2048 };
const PRICE_PER_GB = 0.09; // AWS S3 internet egress, the worst case; R2 charges nothing

// ------------------------------------------------------------- settings ---

export function storageOf(repo) {
    const s = repo.settings();
    return s.storage && s.storage.bucket ? { endpoint: s.storage.endpoint, region: s.storage.region || 'auto', bucket: s.storage.bucket, prefix: (s.storage.prefix || '').replace(/^\/+|\/+$/g, '') } : null;
}

export function setStorage(repo, { endpoint, region, bucket, prefix }) {
    if (!endpoint || !bucket) throw new Error('--endpoint and --bucket are required');
    return repo.writeSettings({ storage: { endpoint: endpoint.replace(/\/+$/, ''), region: region || 'auto', bucket, prefix: prefix || '' } }).storage;
}

export function budgetsOf(repo) {
    return { ...DEFAULT_BUDGETS, ...(repo.settings().budgets || {}) };
}

export function setBudgets(repo, patch) {
    return repo.writeSettings({ budgets: { ...budgetsOf(repo), ...patch } }).budgets;
}

// ---------------------------------------------------------- credentials ---

function storageId(repo) {
    const p = repo.settings().protection;
    return (p && p.id) || 'memory';
}

/** Find an access key pair (and, if present, endpoint, bucket, region) anywhere in a JSON file: a Key Vault pack or a plain file. */
export function readCredentialFile(file) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const found = {};
    const want = { accessKeyId: /^(aws_?)?access_?key_?id$/i, secretAccessKey: /^(aws_?)?secret_?(access_?)?key$/i, endpoint: /^(s3_?)?endpoint(_?url)?$/i, bucket: /^(s3_?)?bucket(_?name)?$/i, region: /^(aws_?)?region$/i, prefix: /^prefix$/i };
    const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            for (const [name, re] of Object.entries(want)) if (re.test(k) && typeof v === 'string' && found[name] === undefined) found[name] = v;
            if (v && typeof v === 'object') walk(v);
        }
    };
    walk(j);
    if (!found.accessKeyId || !found.secretAccessKey) throw new Error(`${basename(file)} holds no access key pair`);
    return found;
}

export function storeCredentials(repo, { accessKeyId, secretAccessKey }) {
    return storeSecret(storageId(repo), Buffer.from(JSON.stringify({ accessKeyId, secretAccessKey }), 'utf8'), 's3');
}

export function hasCredentials(repo) {
    return hasSecret(storageId(repo), 's3');
}

export function loadCredentials(repo) {
    const b = loadSecret(storageId(repo), 's3');
    if (!b) throw new Error('this computer holds no storage key. Provide one with "engram storage key --file <key vault pack or json>"');
    return JSON.parse(b.toString('utf8'));
}

// --------------------------------------------------------- Signature V4 ---

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Sign a request; returns the headers to send. payloadHash is the hex sha256 of the body. */
export function sign({ method, host, path, query = '', headers = {}, payloadHash, region, service = 's3', creds, now = new Date() }) {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const h = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
    const canonicalHeaders = names.map((k) => `${k}:${String(h[Object.keys(h).find((x) => x.toLowerCase() === k)]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalPath = path.split('/').map((seg) => enc(seg)).join('/');
    const canonical = [method, canonicalPath, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac('AWS4' + creds.secretAccessKey, date), region), service), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    h.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return h;
}

/** One S3 request, path-style: <endpoint>/<bucket>/<key>. body: Buffer, or { path, size } to stream a file. */
export function s3Request(repo, method, key, { body = null, contentType } = {}) {
    const st = storageOf(repo);
    if (!st) throw new Error('no long-term storage configured. Set it with "engram storage set --endpoint ... --bucket ..."');
    const creds = loadCredentials(repo);
    const url = new URL(st.endpoint);
    const objectKey = (st.prefix ? st.prefix + '/' : '') + key;
    const path = `/${st.bucket}/${objectKey}`;
    const isFile = body && typeof body === 'object' && !Buffer.isBuffer(body) && body.path;
    const payloadHash = body ? (isFile ? hashFile(body.path) : sha256(body)) : sha256('');
    const headers = sign({ method, host: url.host, path, payloadHash, region: st.region, creds, headers: { ...(contentType ? { 'content-type': contentType } : {}), ...(body ? { 'content-length': String(isFile ? body.size : body.length) } : {}) } });
    const lib = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const req = lib.request({ host: url.hostname, port: url.port || undefined, method, path, headers, timeout: 120000 }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), objectKey }));
        });
        req.on('timeout', () => { req.destroy(new Error('storage request timed out')); });
        req.on('error', reject);
        if (isFile) createReadStream(body.path).pipe(req);
        else req.end(body || undefined);
    });
}

function hashFile(path) {
    const h = createHash('sha256');
    h.update(readFileSync(path));
    return h.digest('hex');
}

// ----------------------------------------------------------- the ledger ---

function spent(repo, filter) {
    let bytes = 0;
    for (const e of readLedger(repo)) if (e.action === 'fetch' && filter(e)) bytes += e.bytes || 0;
    return bytes;
}

function readLedger(repo) {
    const out = [];
    if (!existsSync(repo.ledgerDir)) return out;
    for (const d of readdirSync(repo.ledgerDir)) {
        const dir = join(repo.ledgerDir, d);
        let files = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const f of files) {
            try { for (const e of JSON.parse(readFileSync(join(dir, f), 'utf8'))) out.push({ ...e, device: d }); } catch { /* a torn file is skipped */ }
        }
    }
    return out;
}

export function cacheDir(repo) {
    const base = process.env.LOCALAPPDATA || join(homedir(), '.cache');
    return join(base, 'Engram', 'cache', storageId(repo));
}

export function usage(repo, deviceId, sessionId) {
    const today = nowIso().slice(0, 10);
    return {
        todayBytes: spent(repo, (e) => e.device === deviceId && (e.when || '').slice(0, 10) === today),
        sessionBytes: sessionId ? spent(repo, (e) => e.session === sessionId) : 0,
    };
}

// ------------------------------------------------------------ bank, fetch ---

/** The person banks an artefact to long-term storage. Refused without byUser. */
export async function bank(repo, artefactId, { byUser = false, session: sessionId, device: dev } = {}) {
    if (!byUser) throw new Error('banking is the person\'s act. Doc may recommend ("engram recommend"); the person banks with --by-user.');
    const a = repo.findArtefact(artefactId);
    if (!a) throw new Error(`artefact ${artefactId} is not in this memory`);
    if (!existsSync(a.path)) throw new Error(`the bytes are not on this device: ${a.path}`);
    if (a.isDirectory) throw new Error('a directory is not banked as one object; bank the files that matter');
    const device = dev || thisDevice();
    const session = resolveSession(repo, device, sessionId);
    const size = statSync(a.path).size;
    const r = await s3Request(repo, 'PUT', `${a.id}/${a.name}`, { body: { path: a.path, size }, contentType: 'application/octet-stream' });
    if (r.status < 200 || r.status >= 300) throw new Error(`storage refused the upload: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
    const record = { ...a, availability: 'device+storage', banked: nowIso(), objectKey: r.objectKey, bankedBy: device.id };
    repo.writeArtefact(record);
    repo.appendLedger(device.id, { when: record.banked, action: 'bank', artefact: a.id, bytes: size, session: session.id });
    engram(repo, {
        container: a.container,
        kind: 'artefact',
        stimulus: `engram bank ${a.id} --by-user`,
        done: `${a.name} banked to long-term storage as ${r.objectKey} (${size} bytes) from ${device.name || device.id}.`,
        echo: `${a.name} is in long-term storage (${size} bytes, object ${r.objectKey}); also on ${device.id}.`,
        produced_from: [a.engram],
        artefacts: [{ id: a.id, name: a.name }],
    }, { device, session });
    return record;
}

/** Fetch a banked artefact into this device's cache: a reason, the budgets, the hash, the ledger. */
export async function fetchArtefact(repo, artefactId, { reason, session: sessionId, device: dev } = {}) {
    if (!reason || !String(reason).trim()) throw new Error('a fetch needs --reason "<why these bytes are needed now>"; the reason is written to the ledger');
    const a = repo.findArtefact(artefactId);
    if (!a) throw new Error(`artefact ${artefactId} is not in this memory`);
    if (!a.objectKey) throw new Error(`${a.name} is not in long-term storage (availability: ${a.availability})`);
    const device = dev || thisDevice();
    const session = resolveSession(repo, device, sessionId);
    const dest = join(cacheDir(repo), a.id, a.name);
    if (existsSync(dest) && (!a.hash || hashFile(dest) === a.hash)) {
        return { path: dest, bytes: 0, cached: true, cost: 0 };
    }
    const budgets = budgetsOf(repo);
    const use = usage(repo, device.id, session.id);
    const mb = a.size / 1e6;
    const cost = (a.size / 1e9) * PRICE_PER_GB;
    if (use.todayBytes / 1e6 + mb > budgets.deviceDayMB) throw new Error(`over the device's daily budget: ${(use.todayBytes / 1e6).toFixed(1)} MB used today, this object is ${mb.toFixed(1)} MB, the budget is ${budgets.deviceDayMB} MB. It would have cost about $${cost.toFixed(3)}. Raise deviceDayMB in settings.json to allow it.`);
    if (use.sessionBytes / 1e6 + mb > budgets.sessionMB) throw new Error(`over this session's budget: ${(use.sessionBytes / 1e6).toFixed(1)} MB used, this object is ${mb.toFixed(1)} MB, the budget is ${budgets.sessionMB} MB. It would have cost about $${cost.toFixed(3)}.`);
    const st = storageOf(repo);
    const key = a.objectKey.startsWith(st.prefix + '/') && st.prefix ? a.objectKey.slice(st.prefix.length + 1) : a.objectKey;
    const r = await s3Request(repo, 'GET', key);
    if (r.status !== 200) throw new Error(`storage refused the download: HTTP ${r.status} ${r.body.toString('utf8').slice(0, 200)}`);
    if (a.hash && sha256(r.body) !== a.hash) throw new Error('the downloaded bytes do not match the recorded hash; nothing was written');
    mkdirSync(join(cacheDir(repo), a.id), { recursive: true });
    writeFileSync(dest, r.body);
    const when = nowIso();
    repo.appendLedger(device.id, { when, action: 'fetch', artefact: a.id, bytes: r.body.length, session: session.id, reason: String(reason), cost: Number(cost.toFixed(4)) });
    touchSession(repo, session, { artefacts: 0 });
    return { path: dest, bytes: r.body.length, cached: false, cost };
}
