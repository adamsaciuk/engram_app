// ENGRAM core: text helpers shared by the write path, the map builder and
// recall. Plain functions, no state, no dependencies.

const STOP = new Set((
    'the a an and or but if then else of to in on at by for with from as is are was were be been being ' +
    'it its this that these those there here we you i he she they them our your their my me us him her ' +
    'do does did done have has had having not no nor so than too very can could should would will shall ' +
    'may might must into onto over under again further once about above below between through during before ' +
    'after up down out off any all each few more most other some such only own same both because while ' +
    'what which who whom whose when where why how also just like get got make made use used using one two ' +
    'want wants need needs thing things way ways new now also etc'
).split(/\s+/));

/**
 * A light stem so plurals and verb forms meet: zones and zone, routed and
 * route, planning and plan. Conservative on purpose: short words and the
 * -us, -is, -ss endings are left alone. Display text never goes through it.
 */
export function stem(w) {
    if (w.length <= 3) return w;
    if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
    if (w.endsWith('sses')) return w.slice(0, -2);
    if (w.endsWith('ss')) return w;
    if (w.endsWith('s') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
    const undouble = (s) => (s.length > 3 && s[s.length - 1] === s[s.length - 2] && !/[lsz]/.test(s[s.length - 1]) ? s.slice(0, -1) : s);
    if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
    if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
    if (w.endsWith('ly') && w.length > 5) return w.slice(0, -2);
    if (w.endsWith('e') && w.length > 4) return w.slice(0, -1);
    return w;
}

/** Lower-case word tokens of three or more characters, stop words removed, stemmed. */
export function terms(text) {
    if (!text) return [];
    const out = [];
    for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 3 || STOP.has(raw)) continue;
        out.push(stem(raw));
    }
    return out;
}

/** term -> count */
export function termCounts(text) {
    const m = new Map();
    for (const t of terms(text)) m.set(t, (m.get(t) || 0) + 1);
    return m;
}

/** stem -> (surface word -> count): the words as written behind each stem, so a map can print "zones" not "zone" cut short. */
export function termForms(text) {
    const m = new Map();
    if (!text) return m;
    for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 3 || STOP.has(raw)) continue;
        const s = stem(raw);
        if (!m.has(s)) m.set(s, new Map());
        m.get(s).set(raw, (m.get(s).get(raw) || 0) + 1);
    }
    return m;
}

/** Unique terms, in first-seen order. */
export function uniqueTerms(text) {
    return [...new Set(terms(text))];
}

/** A rough token estimate: four characters per token. Good enough for a budget. */
export function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

/** The first line of a text, trimmed to a length, for one-line summaries. */
export function firstLine(text, max = 90) {
    const line = String(text || '').split(/\r?\n/).find((l) => l.trim()) || '';
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** The first sentence of a text, or the first line cut at a word boundary, for a title. */
export function firstSentence(text, max = 70) {
    const line = firstLine(text, 400).replace(/…$/, '');
    const m = line.match(/^(.{12,}?[.!?])(\s|$)/);
    let t = m ? m[1] : line;
    if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '').trim();
    return t.replace(/[.:;,]$/, '').trim();
}

/**
 * A short name, two to five words, for an engram whose writer gave none: the
 * first sentence with stop words dropped, or its first words if too few remain.
 * A name the writer gave is only capped, never reworded.
 */
export function shortName(text, maxWords = 5) {
    const words = firstSentence(text, 200).split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const kept = words.filter((w) => !STOP.has(w.toLowerCase().replace(/[^a-z0-9']/g, '')));
    const pick = (kept.length >= 2 ? kept : words).slice(0, maxWords);
    return pick.join(' ').replace(/[.:;,]$/, '').trim();
}

/** Cap a writer's name at a word count, cutting at a word boundary. */
export function capName(name, maxWords = 5) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ').replace(/[.:;,]$/, '');
}

/** A container segment: lower-case, hyphenated, safe on every file system. */
export function slug(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

/** Jaccard similarity of two term arrays, 0..1. */
export function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
}
