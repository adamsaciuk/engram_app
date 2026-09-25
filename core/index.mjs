// ENGRAM core: the Cortex map builder. Every container's map is derived
// from the engrams beneath it at zero token cost: the digest (from the
// latest digest engram), vocabulary weighted against the rest of the
// Cortex, decisions in force with supersession honoured, contradictions
// flagged, hubs, children, recent, strongest links out, counts. Back-links
// on engrams are derived here too. Nothing here is a source of truth:
// delete every map and this rebuilds them (design decisions, section 2).

import { join } from 'node:path';
import { termCounts, termForms, firstLine } from './text.mjs';
import { STRUCTURAL, BACK_OF, BACK_KINDS, engramText, engramLine, readJson, writeJson, nowIso } from './repository.mjs';
import { renderFrontMatter, wiki } from './note.mjs';

const VOCAB_SIZE = 40;
const HUBS = 5;
const RECENT = 5;
const LINKS_OUT = 5;
const HANDED_CAP = 30;

/** The digest engram's Done section carries answers and gaps as labelled lines. */
export function parseDigestBody(done) {
    const answers = [];
    const gaps = [];
    for (const line of String(done || '').split('\n')) {
        const a = line.match(/^Answers:\s*(.*)$/i);
        const g = line.match(/^Gaps:\s*(.*)$/i);
        if (a) answers.push(...a[1].split('|').map((s) => s.trim()).filter(Boolean));
        if (g) gaps.push(...g[1].split('|').map((s) => s.trim()).filter(Boolean));
    }
    return { answers, gaps };
}

/**
 * Compute every map from the engram list. Pure apart from reading the
 * container tree and titles. Returns maps (path -> map), back (id -> back
 * links), strength (pair key -> number) and byId.
 */
export function computeMaps(repo, engrams) {
    const containers = repo.listContainers();
    const byId = new Map(engrams.map((e) => [e.id, e]));
    const own = new Map(containers.map((c) => [c, []]));
    for (const e of engrams) { if (!own.has(e.container)) own.set(e.container, []); own.get(e.container).push(e); }
    const deepCache = new Map();
    const deep = (p) => {
        if (deepCache.has(p)) return deepCache.get(p);
        const list = [...(own.get(p) || [])];
        for (const c of repo.children(p)) list.push(...deep(c));
        deepCache.set(p, list);
        return list;
    };
    for (const c of containers) deep(c);

    // back-links and in-link counts
    const back = new Map();
    const inlinks = new Map();
    const supersededBy = new Map();
    const confirmedAt = new Map(); // id -> latest 'when' of an engram confirming it
    const contradictions = [];
    for (const e of engrams) {
        for (const l of e.links || []) {
            if (!byId.has(l.id)) continue;
            const bk = BACK_OF[l.kind];
            if (!bk) continue;
            if (!back.has(l.id)) back.set(l.id, {});
            const b = back.get(l.id);
            (b[bk] = b[bk] || []).push(e.id);
            inlinks.set(l.id, (inlinks.get(l.id) || 0) + 1);
            if (l.kind === 'supersedes') supersededBy.set(l.id, e.id);
            if (l.kind === 'confirms') confirmedAt.set(l.id, max(confirmedAt.get(l.id), e.when));
            if (l.kind === 'contradicts') contradictions.push({ a: e.id, b: l.id, when: e.when });
        }
    }
    for (const b of back.values()) for (const k of Object.keys(b)) b[k].sort();

    // open contradictions: neither end superseded, neither end confirmed since the flag
    // A contradiction is two rulings, or two facts, that cannot both stand
    // (D-A965). A ruling against a fact is never one: the ruling governs and
    // the fact stays cited, whatever link the writer used.
    const isRuling = (id) => { const e = byId.get(id); return !!(e && e.kind === 'decision'); };
    const open = contradictions.filter((c) => isRuling(c.a) === isRuling(c.b)
        && !supersededBy.has(c.a) && !supersededBy.has(c.b)
        && !(confirmedAt.get(c.a) > c.when) && !(confirmedAt.get(c.b) > c.when));

    // strength: explicit links, citations, and being handed over together
    const strength = new Map();
    const bump = (a, b, by) => {
        if (!a || !b || a === b || !byId.has(a) || !byId.has(b)) return;
        const key = a < b ? a + '|' + b : b + '|' + a;
        strength.set(key, (strength.get(key) || 0) + by);
    };
    for (const e of engrams) for (const l of e.links || []) bump(e.id, l.id, l.kind === 'cites' ? 1 : 2);
    const traces = repo.readTraces();
    const together = new Map();
    for (const t of traces) {
        const handed = (t.handed || []).slice(0, HANDED_CAP);
        for (let i = 0; i < handed.length; i++) for (let j = i + 1; j < handed.length; j++) bump(handed[i], handed[j], 0.25);
        const entered = t.entered || [];
        for (const a of entered) {
            if (!together.has(a)) together.set(a, new Map());
            for (const b of entered) if (a !== b) together.get(a).set(b, (together.get(a).get(b) || 0) + 1);
        }
    }

    // term frequencies per container (deep) and document frequency across containers
    const tf = new Map();
    const df = new Map();
    const forms = new Map(); // stem -> surface -> count, across the memory, for display
    for (const c of containers) {
        const counts = new Map();
        for (const e of deep(c)) {
            if (STRUCTURAL.has(e.kind)) continue;
            for (const [t, n] of termCounts(engramText(e))) counts.set(t, (counts.get(t) || 0) + n);
            if (c === '') for (const [s, f] of termForms(engramText(e))) { if (!forms.has(s)) forms.set(s, new Map()); for (const [w, n] of f) forms.get(s).set(w, (forms.get(s).get(w) || 0) + n); }
        }
        tf.set(c, counts);
        for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    const display = (s) => { const f = forms.get(s); if (!f) return s; let best = s; let n = -1; for (const [w, k] of f) if (k > n) { n = k; best = w; } return best; };
    const N = containers.length;

    const maps = new Map();
    const byDepth = [...containers].sort((a, b) => depth(b) - depth(a));
    for (const c of byDepth) {
        const list = deep(c);
        const here = own.get(c) || [];
        const counts = tf.get(c);

        // [stem, weight, the word as written]: scoring reads the stem, people read the word
        const vocabulary = [...counts.entries()]
            .map(([t, n]) => [t, round((1 + Math.log(n)) * Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 0.01), display(t)])
            .sort((a, b) => b[1] - a[1])
            .slice(0, VOCAB_SIZE);

        const latestDigest = here.filter((e) => e.kind === 'digest').sort((a, b) => (a.id < b.id ? 1 : -1))[0] || null;
        const dg = latestDigest ? parseDigestBody(latestDigest.done) : { answers: [], gaps: [] };

        const decisions = [];
        const superseded = [];
        for (const e of list) {
            if (e.kind !== 'decision' || !e.decision) continue;
            if (supersededBy.has(e.id)) superseded.push({ engram: e.id, container: e.container, text: e.decision, when: e.when, by: supersededBy.get(e.id) });
            else decisions.push({ engram: e.id, container: e.container, text: e.decision, when: e.when });
        }
        decisions.sort((a, b) => (a.when < b.when ? -1 : 1));

        const ids = new Set(list.map((e) => e.id));
        const flagged = open.filter((x) => ids.has(x.a) || ids.has(x.b)).map((x) => ({ a: x.a, b: x.b, aLine: engramLine(byId.get(x.a)), bLine: engramLine(byId.get(x.b)) }));

        const hubs = [...list]
            .map((e) => ({ e, n: inlinks.get(e.id) || 0 }))
            .filter((x) => x.n > 0 && !STRUCTURAL.has(x.e.kind))
            .sort((a, b) => b.n - a.n || (b.e.when > a.e.when ? 1 : -1))
            .slice(0, HUBS)
            .map((x) => ({ id: x.e.id, line: engramLine(x.e), inlinks: x.n }));

        const children = repo.children(c).map((p) => {
            const m = maps.get(p);
            const line = m && m.digest ? firstLine(m.digest, 120) : `${m ? m.counts.engrams + m.counts.descendants : 0} engrams, no digest yet`;
            return { path: p, title: m ? m.title : p.split('/').pop(), line, engrams: m ? m.counts.engrams + m.counts.descendants : 0, decisions: m ? m.decisions.length : 0 };
        });

        const recent = [...list].filter((e) => !STRUCTURAL.has(e.kind)).sort((a, b) => (a.when < b.when ? 1 : -1)).slice(0, RECENT)
            .map((e) => ({ id: e.id, when: e.when, line: engramLine(e) }));

        const out = new Map();
        const inside = (p) => p === c || (c === '' ? true : p.startsWith(c + '/'));
        for (const e of list) for (const l of e.links || []) {
            const t = byId.get(l.id);
            if (!t || inside(t.container)) continue;
            out.set(t.container, (out.get(t.container) || 0) + 1);
        }
        for (const [p, n] of (together.get(c) || new Map())) if (!inside(p)) out.set(p, (out.get(p) || 0) + n);
        const linksOut = [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, LINKS_OUT).map(([path, count]) => ({ path, count }));

        const newest = list.reduce((m, e) => (!m || e.id > m ? e.id : m), null);

        maps.set(c, {
            path: c,
            title: repo.readTitle(c),
            digest: latestDigest ? latestDigest.echo : '',
            digestNewest: latestDigest ? latestDigest.id : null,
            answers: dg.answers,
            gaps: dg.gaps,
            vocabulary,
            decisions,
            superseded,
            contradictions: flagged,
            hubs,
            children,
            recent,
            linksOut,
            newest,
            counts: { engrams: here.length, descendants: list.length - here.length, children: children.length },
            updated: nowIso(),
        });
    }
    return { maps, back, strength, byId };
}

/** The map note as Obsidian reads it: properties, then the map in prose and lists. */
export function renderMapNote(m, repo) {
    const link = (p) => (repo ? repo.mapLink(p) : (p ? p + '/' : '') + '_map');
    const fm = { type: 'map', path: m.path || '/', title: m.title, engrams: m.counts.engrams, beneath: m.counts.descendants, children: m.counts.children, decisions: m.decisions.length, superseded: m.superseded.length, contradictions: m.contradictions.length, newest: m.newest || '', updated: m.updated };
    const L = [renderFrontMatter(fm)];
    L.push(`# ${m.title || 'root'}`);
    L.push('');
    L.push(m.digest || '_No digest yet._');
    L.push('');
    if (m.answers.length) L.push('**Answers:** ' + m.answers.join(' · ') + '\n');
    if (m.gaps.length) L.push('**Known gaps:** ' + m.gaps.join(' · ') + '\n');
    if (m.decisions.length) {
        L.push('## Decisions in force');
        for (const d of m.decisions) L.push(`- ${d.text} (${wiki(d.engram)}, ${d.container || 'root'}, ${d.when.slice(0, 10)})`);
        L.push('');
    }
    if (m.superseded.length) {
        L.push('## Superseded');
        for (const d of m.superseded) L.push(`- ~~${d.text}~~ (${wiki(d.engram)}) superseded by ${wiki(d.by)}`);
        L.push('');
    }
    if (m.contradictions.length) {
        L.push('## Contradictions flagged');
        for (const x of m.contradictions) L.push(`- ${wiki(x.a)} contradicts ${wiki(x.b)}: ${firstLine(x.aLine, 60)} vs ${firstLine(x.bLine, 60)}`);
        L.push('');
    }
    if (m.linksOut.length) {
        L.push('## Strongest links out');
        for (const h of m.linksOut) L.push(`- [[${link(h.path)}|${h.path || 'root'}]] (${h.count})`);
        L.push('');
    }
    if (m.children.length) {
        L.push('## Children');
        for (const ch of m.children) L.push(`- [[${link(ch.path)}|${ch.title}]]: ${ch.line}`);
        L.push('');
    }
    if (m.hubs.length) {
        L.push('## Hubs');
        for (const h of m.hubs) L.push(`- ${wiki(h.id)}: ${h.line} (${h.inlinks} in-links)`);
        L.push('');
    }
    if (m.recent.length) {
        L.push('## Recent');
        for (const r of m.recent) L.push(`- ${r.when.slice(0, 10)} ${wiki(r.id)}: ${r.line}`);
        L.push('');
    }
    if (m.vocabulary.length) L.push('**Vocabulary:** ' + m.vocabulary.slice(0, 20).map((v) => v[2] || v[0]).join(', ') + '\n');
    return L.join('\n');
}

/** Rewrite the back-links of every engram whose set changed; returns the containers those engrams live in. */
function writeBackLinks(repo, engrams, back) {
    const touched = new Set();
    for (const e of engrams) {
        const computed = {};
        for (const k of BACK_KINDS) computed[k] = (back.get(e.id) || {})[k] || [];
        const same = BACK_KINDS.every((k) => JSON.stringify(computed[k]) === JSON.stringify((e.back || {})[k] || []));
        if (!same) { repo.rewriteEngramHeader({ ...e, back: computed }); e.back = computed; touched.add(e.container); }
    }
    return touched;
}

function saveComputed(repo, computed) {
    const maps = Object.fromEntries(computed.maps);
    const strength = Object.fromEntries(computed.strength);
    writeJson(join(repo.localDir, 'maps.json'), { at: nowIso(), maps, strength });
}

/** Rebuild every map and every back-link. Returns the number of containers rebuilt. */
export function rebuildAll(repo) {
    repo.renameLegacyEngrams();
    const engrams = repo.allEngrams();
    const computed = computeMaps(repo, engrams);
    for (const [c, m] of computed.maps) repo.writeMapNote(c, renderMapNote(m, repo));
    writeBackLinks(repo, engrams, computed.back);
    saveComputed(repo, computed);
    repo.saveCache();
    return computed.maps.size;
}

/**
 * Rebuild only the touched containers and their ancestors (D-A780). The
 * computation still reads every engram (cross-container weighting needs
 * it, and the parsed-engram cache makes that cheap); what is saved is the
 * writing. Back-links are written for every engram whose set changed.
 */
export function rebuildTouched(repo, touched) {
    const engrams = repo.allEngrams();
    const computed = computeMaps(repo, engrams);
    const targets = new Set();
    const add = (t) => { targets.add(t); for (const a of repo.ancestors(t)) targets.add(a); };
    for (const t of touched) add(t);
    // a link out of the touched container changes the target's hubs and back-links, so its map is rewritten too
    for (const c of writeBackLinks(repo, engrams, computed.back)) add(c);
    for (const c of targets) if (computed.maps.has(c)) repo.writeMapNote(c, renderMapNote(computed.maps.get(c), repo));
    saveComputed(repo, computed);
    repo.saveCache();
    return targets.size;
}

/** Maps and strength for recall: the local cache when fresh, else computed now. */
export function readMaps(repo, engrams) {
    const cached = readJson(join(repo.localDir, 'maps.json'), null);
    const newest = engrams.reduce((m, e) => (!m || e.id > m ? e.id : m), null);
    if (cached && cached.maps && cached.maps[''] && cached.maps[''].newest === newest && Object.keys(cached.maps).length === repo.listContainers().length) {
        return { maps: new Map(Object.entries(cached.maps)), strength: new Map(Object.entries(cached.strength || {})) };
    }
    const computed = computeMaps(repo, engrams);
    saveComputed(repo, computed);
    return { maps: computed.maps, strength: computed.strength };
}

function depth(p) {
    return p ? p.split('/').length : 0;
}

function round(x) {
    return Math.round(x * 1000) / 1000;
}

function max(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a > b ? a : b;
}
