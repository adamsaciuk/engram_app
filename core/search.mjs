// ENGRAM core: the index a person searches (D-A969) and the brief a
// session takes on a project (D-A966).
//
// search: Google-style. Every Echo in the memory is scored on the query
// (stemmed terms, frequency and rarity), and a region whose name or title
// the query names is taken whole: everything beneath it is listed even
// when an Echo does not repeat the word. No budget, no modes; a project
// name returns the index of everything associated with it.
//
// brief: one region handed over at a fixed cost: its map, the rulings in
// force, the recent Echos, the open gaps, the children. What a second
// session reads first to pick a project up.

import { uniqueTerms, termCounts, estimateTokens, firstLine } from './text.mjs';
import { STRUCTURAL, engramText } from './repository.mjs';
import { readMaps } from './index.mjs';
import { renderMap } from './rules.mjs';

const countsCache = new WeakMap();
function countsOf(e) {
    let c = countsCache.get(e);
    if (!c) { c = termCounts(engramText(e)); countsCache.set(e, c); }
    return c;
}

/** How strongly a container's own name or title matches the query terms, 0..1. */
function nameMatch(repo, path, terms, rawWords) {
    if (!path) return 0;
    const leaf = path.split('/').pop();
    const segs = leaf.split('-').filter((s) => s.length > 2);
    const title = uniqueTerms(repo.readTitle(path));
    const names = new Set([...segs, ...title, ...uniqueTerms(segs.join(' '))]);
    let hit = 0;
    for (const t of terms) if (names.has(t)) hit++;
    for (const w of rawWords) if (!terms.includes(w) && names.has(w)) hit++;
    if (!hit) return 0;
    // the whole leaf name typed (orko, north-grid) is a full match
    if (rawWords.includes(leaf) || rawWords.join(' ') === segs.join(' ')) return 1;
    return Math.min(1, hit / Math.max(1, terms.length));
}

export function search(repo, q, { limit = 300 } = {}) {
    const t0 = Date.now();
    const terms = uniqueTerms(q);
    const rawWords = String(q || '').toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
    const engrams = repo.allEngrams().filter((e) => !STRUCTURAL.has(e.kind));
    const { maps } = readMaps(repo, repo.allEngrams());
    const containers = repo.listContainers();

    // regions named by the query
    const named = new Map();
    for (const c of containers) {
        const s = nameMatch(repo, c, terms, rawWords);
        if (s > 0) named.set(c, s);
    }
    const under = (e) => { let best = 0; for (const [c, s] of named) if (e.container === c || e.container.startsWith(c + '/')) best = Math.max(best, s); return best; };

    // every Echo scored
    const df = new Map();
    for (const e of engrams) for (const t of new Set(countsOf(e).keys())) df.set(t, (df.get(t) || 0) + 1);
    const N = engrams.length || 1;
    const supersededIds = new Set();
    for (const s of (maps.get('') || { superseded: [] }).superseded || []) supersededIds.add(s.engram);
    const scored = [];
    for (const e of engrams) {
        const counts = countsOf(e);
        let s = 0;
        const why = [];
        for (const t of terms) {
            const tf = counts.get(t) || 0;
            if (!tf) continue;
            s += (tf / (tf + 1.2)) * Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
            why.push(t);
        }
        const region = under(e);
        if (region > 0) s += 1.5 * region;
        if (s === 0) continue;
        if (e.kind === 'decision') s += 0.2;
        if (supersededIds.has(e.id)) s *= 0.5;
        if (e.kind === 'consolidation') s *= 1.3;
        scored.push({ e, score: s, why, region });
    }
    scored.sort((a, b) => b.score - a.score || (a.e.when < b.e.when ? 1 : -1));

    const echos = scored.slice(0, limit).map(({ e, score, why, region }) => ({
        id: e.id, kind: e.kind, when: e.when, container: e.container, title: e.title, echo: e.echo, decision: e.decision, tags: e.tags,
        session: e.session, device: e.device, edited: e.edited || '', superseded: supersededIds.has(e.id), links: (e.links || []).length,
        score: Math.round(score * 100) / 100, why, inRegion: region > 0,
    }));

    // the regions to show: named ones first, then the containers the top Echos live in
    const regions = [];
    const seen = new Set();
    const pushRegion = (c, score, byName) => {
        if (seen.has(c) || !maps.has(c)) return;
        seen.add(c);
        const m = maps.get(c);
        regions.push({ path: c, title: m.title, score: Math.round(score * 100) / 100, byName, engrams: m.counts.engrams + m.counts.descendants, decisions: m.decisions.length, gaps: m.gaps.length, line: firstLine(m.digest, 140) || '' });
    };
    for (const [c, s] of [...named.entries()].sort((a, b) => b[1] - a[1])) pushRegion(c, s, true);
    const tally = new Map();
    for (const x of scored.slice(0, 60)) tally.set(x.e.container, (tally.get(x.e.container) || 0) + x.score);
    for (const [c, s] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) pushRegion(c, s / 10, false);

    // decisions in force: from the named regions whole, then any decision among the matches
    const decisions = [];
    const dseen = new Set();
    for (const r of regions.filter((x) => x.byName)) for (const d of (maps.get(r.path) || { decisions: [] }).decisions) if (!dseen.has(d.engram)) { dseen.add(d.engram); decisions.push(d); }
    for (const x of scored) if (x.e.kind === 'decision' && x.e.decision && !supersededIds.has(x.e.id) && !dseen.has(x.e.id)) { dseen.add(x.e.id); decisions.push({ engram: x.e.id, container: x.e.container, text: x.e.decision, when: x.e.when }); }

    const gaps = [];
    for (const r of regions.filter((x) => x.byName)) for (const g of (maps.get(r.path) || { gaps: [] }).gaps) gaps.push({ gap: g, container: r.path });

    return { q, terms, regions, decisions, gaps, echos, total: scored.length, ms: Date.now() - t0 };
}

/**
 * The brief for one region: what a session reads first when the task
 * belongs to a project the memory knows. Fixed cost: the map, the rulings
 * in force, the most recent Echos to the budget, the gaps.
 */
export function brief(repo, path, { attention = 4000 } = {}) {
    const p = String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!repo.hasContainer(p)) throw new Error(`no container "${p || 'root'}"`);
    const all = repo.allEngrams();
    const { maps } = readMaps(repo, all);
    const m = maps.get(p);
    const parts = [];
    let used = 0;
    const push = (text) => { parts.push(text); used += estimateTokens(text); };
    push(`# BRIEF: ${m.title} (${p || 'root'})\n`);
    push(renderMap(m) + '\n');
    if (m.decisions.length) {
        push('## Rulings in force');
        for (const d of m.decisions) push(`- ${d.text} (${d.engram}, ${d.container || 'root'}, ${d.when.slice(0, 10)})`);
        push('');
    }
    const inside = all.filter((e) => !STRUCTURAL.has(e.kind) && (e.container === p || (p ? e.container.startsWith(p + '/') : true)))
        .sort((a, b) => (a.when < b.when ? 1 : -1));
    const handed = [];
    const excluded = [];
    push('## Recent Echos, newest first');
    for (const e of inside) {
        const line = `- ${e.when.slice(0, 10)} [${e.kind}] ${e.title} (${e.id}, ${e.container})\n  ${e.echo.replace(/\n+/g, ' ')}`;
        const cost = estimateTokens(line);
        if (used + cost > attention) { excluded.push(e.id); continue; }
        push(line);
        handed.push(e.id);
    }
    if (excluded.length) push(`\n(${excluded.length} older Echos not shown: engram recall "<the task>" reaches them, or raise --attention.)`);
    if (m.gaps.length) { push('\n## Known gaps'); for (const g of m.gaps) push(`- ${g}`); }
    return { path: p, title: m.title, bundle: parts.join('\n') + '\n', handed, excluded: excluded.length, decisions: m.decisions, gaps: m.gaps, used, attention };
}
