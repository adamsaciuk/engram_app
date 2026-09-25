// ENGRAM core: compacting (D-A786). A region that has gathered many small
// Echos is many small reads. A consolidation is one engram, written from
// those Echos, that stands for them: recall ranks it up and steps the
// covered Echos back, and the originals stay one link away. Immutable
// like everything else; a later consolidation covers the earlier one.
// Sleep consolidates. This is how memory works.
//
// Who writes it: the session's AI (engram compact <container> prints the
// Echos, engram compact <container> --echo "..." --covers a,b,c writes),
// or the scheduled pass with a Claude API key in the key store
// (engram compact <container> --auto). The tool never invents the text.

import http from 'node:http';
import https from 'node:https';
import { estimateTokens, firstLine } from './text.mjs';
import { STRUCTURAL, normalizeContainerPath, nowIso } from './repository.mjs';
import { engram } from './engram.mjs';
import { storeSecret, loadSecret, hasSecret } from './secrets.mjs';

export const COMPACT_MIN = 12;        // uncovered Echos before sleep proposes compacting
export const COMPACT_AGE_DAYS = 7;    // only Echos older than this are candidates
export const CONSOLIDATION_MAX_TOKENS = 400;

/** The Echos in one container (own, not deep) that no consolidation covers yet. */
export function candidates(repo, path, { ageDays = COMPACT_AGE_DAYS, all = false } = {}) {
    const p = normalizeContainerPath(path);
    const cutoff = Date.now() - ageDays * 86400000;
    return repo.listEngrams(p).filter((e) => !STRUCTURAL.has(e.kind)
        && e.kind !== 'consolidation'
        && !(e.back && e.back.consolidated_by && e.back.consolidated_by.length)
        && (all || Date.parse(e.when) < cutoff));
}

/** What sleep proposes: containers with enough uncovered, settled Echos. */
export function proposals(repo) {
    const out = [];
    for (const c of repo.listContainers()) {
        const n = candidates(repo, c).length;
        if (n >= COMPACT_MIN) out.push({ container: c, count: n });
    }
    return out;
}

/** The text a writer reads before consolidating: the Echos, oldest first, with ids. */
export function brief(repo, path, list) {
    const p = normalizeContainerPath(path);
    const L = [`# Compact ${p || 'root'}`, '', `${list.length} Echos to consolidate into one. Write the consolidation as an Echo: what was asked across them, what is now true, what to watch for. Keep decisions as decisions (they stay in force on the map regardless). Under ${CONSOLIDATION_MAX_TOKENS} tokens.`, ''];
    for (const e of list) L.push(`- ${e.id} · ${e.kind} · ${e.when.slice(0, 10)}: ${e.echo.replace(/\s+/g, ' ')}`);
    L.push('', `Then: engram compact ${p || '/'} --name "<two to five words>" --echo "<the consolidation>" --covers ${list.map((e) => e.id).join(',')}`);
    return L.join('\n');
}

/** Write the consolidation. Refuses an empty cover list or an over-long Echo. */
export function consolidate(repo, path, { echo, covers, name, session, device } = {}) {
    const p = normalizeContainerPath(path);
    if (!echo || !String(echo).trim()) throw new Error('a consolidation needs --echo "<the consolidated Echo>"');
    if (estimateTokens(echo) > CONSOLIDATION_MAX_TOKENS) throw new Error(`the consolidation is ${estimateTokens(echo)} tokens; keep it under ${CONSOLIDATION_MAX_TOKENS}`);
    const ids = [].concat(covers || []).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('--covers <id,id,...> names the Echos this consolidation stands for');
    for (const id of ids) {
        const e = repo.findEngram(id);
        if (!e) throw new Error(`${id} is not an engram in this memory`);
        if (e.container !== p) throw new Error(`${id} lives in ${e.container || 'root'}, not ${p || 'root'}; a consolidation covers one container`);
    }
    return engram(repo, {
        container: p,
        kind: 'consolidation',
        name: name || `Consolidated ${ids.length} Echos`,
        stimulus: `engram compact ${p || '/'} (${ids.length} Echos)`,
        done: `Consolidated ${ids.length} Echos of ${p || 'root'} on ${nowIso().slice(0, 10)}. The originals stay one link away.`,
        echo: String(echo).trim(),
        consolidates: ids,
        session,
    }, { device, session });
}

// ------------------------------------------------ the automatic writer ---

const API_ID = 'anthropic';

export function storeApiKey(key) {
    return storeSecret(API_ID, Buffer.from(String(key).trim(), 'utf8'), 'api');
}

export function hasApiKey() {
    return hasSecret(API_ID, 'api') || !!process.env.ANTHROPIC_API_KEY;
}

function apiKey() {
    if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
    const b = loadSecret(API_ID, 'api');
    if (!b) throw new Error('no Claude API key on this computer. Store one with "engram compact key --file <file holding the key>" or set ANTHROPIC_API_KEY');
    return b.toString('utf8').trim();
}

/** Ask Claude for the consolidation text. Returns the Echo text; nothing is written here. */
export function writeWithClaude(repo, path, list, { model = process.env.ENGRAM_MODEL || 'claude-sonnet-5', endpoint = process.env.ENGRAM_API_URL || 'https://api.anthropic.com/v1/messages' } = {}) {
    const prompt = brief(repo, path, list).split('\nThen: ')[0] + '\n\nAnswer with the consolidation text only.';
    const body = JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    const url = new URL(endpoint);
    const lib = url.protocol === 'http:' ? http : https; // http only for a test server
    return new Promise((resolve, reject) => {
        const opts = { host: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) }, timeout: 60000 };
        const req = lib.request(opts, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                try {
                    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (res.statusCode !== 200) return reject(new Error(`Claude API: HTTP ${res.statusCode} ${(j.error && j.error.message) || ''}`));
                    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
                    resolve({ text, usage: j.usage || {} });
                } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Claude API timed out')));
        req.on('error', reject);
        req.end(body);
    });
}

export { firstLine };
