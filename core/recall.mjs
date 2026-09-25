// ENGRAM core: recall. Turns a task into a briefing: read the root map,
// enter the regions that match, descend by map score, read the Echos that
// matter, follow typed links one hop into other branches, put the
// decisions in force first with superseded rulings marked as history, and
// stop at the token budget. Writes a trace so routes learn from use.
//
// Lexical plus tree plus links, no dependencies, local, on disk.

import { uniqueTerms, termCounts, estimateTokens, jaccard, firstLine } from './text.mjs';
import { STRUCTURAL, engramText, thisDevice } from './repository.mjs';
import { readMaps } from './index.mjs';
import { renderMap } from './rules.mjs';
import { resolveSession, touchSession } from './session.mjs';

const DEFAULTS = { attention: 8000, k: 3, maxDepth: 8, widen: 10, write: true, mode: 'ai' };

export function recall(repo, task, options = {}) {
    const t0 = Date.now();
    const opts = { ...DEFAULTS, ...options };
    if (opts.mode === 'all') { opts.attention = 1e9; opts.k = 50; opts.widen = 50; }
    const taskTerms = uniqueTerms(task);
    const when = new Date().toISOString();
    const engrams = repo.allEngrams();
    const byId = new Map(engrams.map((e) => [e.id, e]));
    const { maps, strength } = readMaps(repo, engrams);

    // --- learned routes: what similar tasks did before
    const containerPrior = new Map();
    const citedPrior = new Map();
    for (const t of repo.readTraces()) {
        const sim = jaccard(t.terms || [], taskTerms);
        if (sim < 0.2) continue;
        for (const c of t.entered || []) containerPrior.set(c, (containerPrior.get(c) || 0) + sim);
    }
    for (const e of engrams) {
        const cites = (e.links || []).filter((l) => l.kind === 'cites');
        if (!cites.length) continue;
        const sim = jaccard(uniqueTerms(e.stimulus), taskTerms);
        if (sim < 0.2) continue;
        for (const l of cites) citedPrior.set(l.id, (citedPrior.get(l.id) || 0) + sim);
    }

    const scoreContainer = (path) => {
        const m = maps.get(path);
        if (!m) return 0;
        let vocab = 0;
        let top = 0;
        (m.vocabulary || []).forEach(([t, w], i) => {
            if (i < 10) top += w;
            if (taskTerms.includes(t)) vocab += w;
        });
        const vocabScore = top > 0 ? vocab / top : 0;
        const proseTerms = new Set(uniqueTerms([m.title, m.digest, ...(m.answers || [])].join(' ')));
        let prose = 0;
        for (const t of taskTerms) if (proseTerms.has(t)) prose++;
        const proseScore = taskTerms.length ? prose / taskTerms.length : 0;
        const name = path.split('/').pop();
        const segments = name ? name.split('-') : [];
        const nameScore = segments.some((s) => s.length > 3 && taskTerms.includes(s)) ? 0.5 : 0;
        return vocabScore + 0.6 * proseScore + nameScore + 0.5 * (containerPrior.get(path) || 0);
    };

    // --- descend. A container is worth entering if it matches OR something
    // beneath it matches: a parent's vocabulary is a summary and cannot carry
    // every grandchild's terms, so the effective score looks down the branch.
    const effective = new Map();
    const effectiveScore = (path) => {
        if (effective.has(path)) return effective.get(path);
        let best = 0;
        for (const c of repo.children(path)) best = Math.max(best, effectiveScore(c));
        const s = Math.max(scoreContainer(path), 0.85 * best);
        effective.set(path, s);
        return s;
    };
    const entered = [];
    const skipped = [];
    const containerScores = new Map();
    const visit = (path, depth) => {
        const kids = repo.children(path).map((p) => ({ path: p, score: effectiveScore(p) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score);
        for (const kid of kids.slice(opts.k)) skipped.push({ path: kid.path, score: kid.score });
        for (const kid of kids.slice(0, opts.k)) {
            entered.push(kid.path);
            containerScores.set(kid.path, kid.score);
            if (depth < opts.maxDepth) visit(kid.path, depth + 1);
        }
    };
    visit('', 1);
    const enteredSet = new Set(['', ...entered]);

    // --- Echo scoring inside entered containers
    const df = new Map();
    for (const e of engrams) for (const t of new Set(termCountsOf(e).keys())) df.set(t, (df.get(t) || 0) + 1);
    const N = engrams.length || 1;
    const now = Date.now();
    const supersededIds = new Set();
    for (const m of maps.values()) for (const s of m.superseded || []) supersededIds.add(s.engram);
    const scoreEngram = (e) => {
        const counts = termCountsOf(e);
        let s = 0;
        for (const t of taskTerms) {
            const tf = counts.get(t) || 0;
            if (!tf) continue;
            s += (tf / (tf + 1.2)) * Math.log((N + 1) / ((df.get(t) || 0) + 0.5));
        }
        if (s === 0) return 0;
        const ageDays = Math.max(0, (now - Date.parse(e.when || 0)) / 86400000);
        s += 0.1 * Math.max(0, 1 - ageDays / 365);
        // a ruling that matches the task is the answer to it: it outranks the actions around it
        if (e.kind === 'decision') s = s * 1.5 + 0.1;
        if (supersededIds.has(e.id)) s *= 0.5;
        // compacting: a consolidation stands for the Echos it covers, so it ranks up and they step back
        if (e.kind === 'consolidation') s *= 1.5;
        if (e.back && e.back.consolidated_by && e.back.consolidated_by.length) s *= 0.35;
        s += 0.15 * (citedPrior.get(e.id) || 0);
        s += 0.05 * ((e.back && e.back.confirmed_by || []).length);
        return s;
    };

    const inside = engrams.filter((e) => enteredSet.has(e.container) && !STRUCTURAL.has(e.kind));
    const scored = inside.map((e) => ({ e, score: scoreEngram(e) })).filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
    const selected = new Set(scored.map((x) => x.e.id));

    // --- widen one hop through typed links and learned strength into other branches
    const linked = new Map();
    for (const { e, score } of scored.slice(0, opts.widen)) {
        const reach = (id, kind) => {
            if (selected.has(id) || linked.has(id)) return;
            const target = byId.get(id);
            if (!target || STRUCTURAL.has(target.kind)) return;
            const key = e.id < id ? e.id + '|' + id : id + '|' + e.id;
            linked.set(id, { e: target, score: 0.6 * score + 0.05 * (strength.get(key) || 0), via: e.id, kind });
        };
        for (const l of e.links || []) reach(l.id, l.kind);
        for (const [k, ids] of Object.entries(e.back || {})) for (const id of ids) reach(id, k);
        // learned strength alone reaches an Echo only once it has been handed over together often
        for (const [key, w] of strength) {
            if (w < 1) continue;
            const [a, b] = key.split('|');
            if (a === e.id) reach(b, 'recalled together');
            else if (b === e.id) reach(a, 'recalled together');
        }
    }
    const linkedList = [...linked.values()].sort((a, b) => b.score - a.score);

    // --- decisions in force across entered containers. The root's list is
    // every decision in the memory, so from the root only its own engrams'
    // decisions count; each entered branch brings everything beneath it.
    const decisions = [];
    const history = [];
    const contradictions = [];
    const gaps = [];
    const seen = new Set();
    for (const c of enteredSet) {
        const m = maps.get(c);
        if (!m) continue;
        for (const d of m.decisions || []) {
            if (c === '' && d.container !== '') continue;
            if (seen.has(d.engram)) continue;
            seen.add(d.engram);
            decisions.push(d);
        }
        for (const d of m.superseded || []) {
            if (c === '' && d.container !== '') continue;
            if (seen.has(d.engram)) continue;
            seen.add(d.engram);
            history.push(d);
        }
        if (c !== '') {
            for (const x of m.contradictions || []) if (!contradictions.some((y) => y.a === x.a && y.b === x.b)) contradictions.push(x);
            for (const g of m.gaps || []) gaps.push({ container: c, gap: g });
        }
    }

    // --- artefacts
    const artefacts = repo.listArtefacts().filter((a) => selected.has(a.engram) || linked.has(a.engram)
        || uniqueTerms(a.name + ' ' + (a.note || '')).some((t) => taskTerms.includes(t)));

    // --- assemble within attention
    const parts = [];
    let used = 0;
    let budgetHit = null;
    const push = (text, force = false) => {
        const cost = estimateTokens(text);
        if (!force && used + cost > opts.attention) return false;
        parts.push(text);
        used += cost;
        return true;
    };
    const excluded = new Map();

    push(`# RECALL\n\nTask: ${task}\n`, true);
    if (opts.rules) push(opts.rules.trimEnd() + '\n', true);
    push('## Root map\n\n' + renderMap(maps.get('')) + '\n', true);

    const route = entered.length ? entered.map((p) => `${p} (${containerScores.get(p).toFixed(2)})`).join(' → ') : '(no container matched; root only)';
    push(`## Route\n\nroot → ${route}\n`, true);
    // Entered containers: one line each, always. Full maps only for the
    // deepest entered containers and only inside a quarter of the budget,
    // so the Echos, which are the point, always get their share.
    if (entered.length) {
        push('## Containers entered\n', true);
        for (const c of entered) {
            const m = maps.get(c);
            push(`- ${c} (${containerScores.get(c).toFixed(2)}): ${m.digest ? firstLine(m.digest, 110) : 'no digest'} · ${m.counts.engrams + m.counts.descendants} engrams · ${m.decisions.length} decisions${m.gaps.length ? ' · ' + m.gaps.length + ' gaps' : ''}`, true);
        }
        const mapBudget = used + Math.floor(opts.attention * 0.25);
        const leaves = entered.filter((c) => !entered.some((o) => o !== c && o.startsWith(c + '/'))).sort((a, b) => containerScores.get(b) - containerScores.get(a));
        for (const c of leaves) {
            const text = renderMap(maps.get(c)) + '\n';
            if (used + estimateTokens(text) > mapBudget) break;
            push(text);
        }
    }

    if (decisions.length) {
        push('## Decisions in force\n', true);
        for (const d of decisions) push(`- ${d.text} (${d.engram}, ${d.container || 'root'}, ${d.when.slice(0, 10)})`, true);
    }
    if (contradictions.length) {
        push('\n## Contradictions flagged (for the person to rule on)\n', true);
        for (const x of contradictions) push(`- ${x.a} vs ${x.b}: ${firstLine(x.aLine, 70)} | ${firstLine(x.bLine, 70)}`, true);
    }

    const handed = [];
    if (scored.length) {
        push('\n## Echos\n');
        for (const { e, score } of scored) {
            if (!push(renderEcho(e, score))) {
                excluded.set(e.container, (excluded.get(e.container) || 0) + 1);
                if (!budgetHit) budgetHit = 'Echos';
            } else handed.push(e.id);
        }
    }
    if (linkedList.length) {
        push('\n## Linked from other branches\n');
        for (const { e, score, via, kind } of linkedList) {
            if (!push(renderEcho(e, score, `${kind} via ${via}`))) {
                excluded.set(e.container, (excluded.get(e.container) || 0) + 1);
                if (!budgetHit) budgetHit = 'Linked';
            } else handed.push(e.id);
        }
    }
    if (history.length) {
        push('\n## Superseded, history only\n', true);
        for (const d of history) push(`- ~~${firstLine(d.text, 90)}~~ (${d.engram}) superseded by ${d.by}`, true);
    }
    if (gaps.length) {
        push('\n## Known gaps\n', true);
        for (const g of gaps) push(`- ${g.container}: ${g.gap}`, true);
    }
    if (artefacts.length) {
        push('\n## Artefacts\n');
        for (const a of artefacts) {
            push(`- ${a.name}: ${a.availability} on ${a.device}${a.path ? ' at ' + a.path : ''}, ${a.size} bytes, engram ${a.engram}${a.note ? ', ' + a.note : ''}`, true);
        }
    }
    const left = [...excluded.entries()];
    if (left.length) {
        const total = left.reduce((n, [, c]) => n + c, 0);
        push(`\n## Not included\n\n${total} more Echos matched: ${left.map(([c, n]) => `${n} in ${c || 'root'}`).join(', ')}. Raise --attention or narrow the task.\n`, true);
    }
    const suggest = suggestContainer(entered, containerScores);
    const ms = Date.now() - t0;
    const containersRead = entered.length;
    const cost = `Recalled ${handed.length} Echos from ${containersRead} container${containersRead === 1 ? '' : 's'} in ${ms} ms. ${used} of ${opts.mode === 'all' ? 'unbounded' : opts.attention} tokens. ${decisions.length} decision${decisions.length === 1 ? '' : 's'} in force. ${history.length} superseded in history. ${gaps.length} known gap${gaps.length === 1 ? '' : 's'}.`;
    push(`\n## Write here\n\nSuggested container for this action: ${suggest || '(open one under root)'}.\n\n${cost}\n`, true);

    const device = opts.device || safeDevice();
    const session = opts.session || (opts.write && device ? resolveSession(repo, device, opts.sessionId) : null);
    const trace = { when, task, terms: taskTerms, entered, handed, attention: opts.attention, used, session: session ? session.id : '', device: device ? device.id : '' };
    if (opts.write && device) {
        repo.appendTrace(device.id, trace);
        if (session) touchSession(repo, session, { recalls: 1, recallTokens: used });
    }

    return {
        bundle: parts.join('\n'), entered, handed, decisions, history, contradictions, gaps, artefacts, excluded: Object.fromEntries(excluded), suggest, used, trace, cost, ms,
        route: { entered: entered.map((p) => ({ path: p, score: containerScores.get(p) })), skipped, budgetHit },
        echos: scored.filter((x) => handed.includes(x.e.id)).map((x) => ({ id: x.e.id, container: x.e.container, kind: x.e.kind, when: x.e.when, score: x.score, title: x.e.title, echo: x.e.echo, links: (x.e.links || []).length, superseded: supersededIds.has(x.e.id) })),
        linked: linkedList.filter((x) => handed.includes(x.e.id)).map((x) => ({ id: x.e.id, container: x.e.container, kind: x.e.kind, when: x.e.when, score: x.score, title: x.e.title, echo: x.e.echo, via: x.via, linkKind: x.kind, superseded: supersededIds.has(x.e.id) })),
    };
}

function safeDevice() {
    try { return thisDevice(); } catch { return null; }
}

function suggestContainer(entered, scores) {
    if (!entered.length) return '';
    return [...entered].sort((a, b) => scores.get(b) - scores.get(a) || b.length - a.length)[0];
}

const countsCache = new WeakMap();
function termCountsOf(e) {
    let c = countsCache.get(e);
    if (!c) {
        c = termCounts(engramText(e));
        countsCache.set(e, c);
    }
    return c;
}

/** An Echo as a session receives it: one header line, the Echo text, and the engram one id away. */
export function renderEcho(e, score, via) {
    const out = [];
    out.push(`### ${e.id} · ${e.container || 'root'} · ${e.kind} · ${(e.when || '').slice(0, 10)}${score !== undefined ? ' · ' + score.toFixed(2) : ''}${via ? ' · ' + via : ''}`);
    if (e.back && e.back.superseded_by && e.back.superseded_by.length) out.push(`Superseded by: ${e.back.superseded_by.join(', ')}`);
    out.push(e.echo || firstLine(e.stimulus, 200));
    return out.join('\n') + '\n';
}

export { firstLine };
