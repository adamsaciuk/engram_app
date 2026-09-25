// ENGRAM core: the note format. Every engram, artefact record and map is
// a markdown note Obsidian can open: a front matter block of properties,
// then a body. This module renders and parses that format and nothing
// else. A small YAML subset is written and read here on purpose (scalars,
// inline lists, block lists) so the core stays zero-dependency.

const BARE = /^[A-Za-z0-9_][A-Za-z0-9_./:+-]*$/;

function scalar(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    if (BARE.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/^[0-9.+-]+$/.test(s)) return s;
    return JSON.stringify(s);
}

/** Render a front matter block. Lists are inline; nested objects are not supported here. */
export function renderFrontMatter(fields) {
    const lines = ['---'];
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) lines.push(`${k}: [${v.map(scalar).join(', ')}]`);
        else lines.push(`${k}: ${scalar(v)}`);
    }
    lines.push('---');
    return lines.join('\n') + '\n';
}

function parseScalar(raw) {
    const s = raw.trim();
    if (s === '') return '';
    if (s.startsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
    if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    return s;
}

function parseInlineList(raw) {
    const s = raw.trim().slice(1, -1);
    const out = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            cur += ch;
            if (ch === '\\' && quote === '"') { cur += s[++i] || ''; continue; }
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
        else if (ch === ',') { if (cur.trim()) out.push(parseScalar(cur)); cur = ''; }
        else cur += ch;
    }
    if (cur.trim()) out.push(parseScalar(cur));
    return out;
}

/**
 * Split a note into { fields, body }. Fields is a plain object; lists come
 * back as arrays. A note with no front matter has empty fields.
 */
export function parseNote(text) {
    const src = String(text || '').replace(/\r\n/g, '\n');
    if (!src.startsWith('---\n')) return { fields: {}, body: src };
    const end = src.indexOf('\n---', 4);
    if (end < 0) return { fields: {}, body: src };
    const head = src.slice(4, end).split('\n');
    const body = src.slice(end + 4).replace(/^\n/, '');
    const fields = {};
    let listKey = null;
    for (const line of head) {
        if (listKey && /^\s*-\s/.test(line)) { fields[listKey].push(parseScalar(line.replace(/^\s*-\s?/, ''))); continue; }
        listKey = null;
        const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        if (v.trim().startsWith('[')) fields[k] = parseInlineList(v);
        else if (v.trim() === '') { fields[k] = []; listKey = k; }
        else fields[k] = parseScalar(v);
    }
    // an empty value that never grew a block list is an empty string, not a list
    for (const [k, v] of Object.entries(fields)) if (Array.isArray(v) && v.length === 0 && !/^(tags|cites|supersedes|refines|confirms|contradicts|produced_from|consolidates|cited_by|superseded_by|refined_by|confirmed_by|contradicted_by|produced|consolidated_by|artefacts|answers|gaps|children|links_out)$/.test(k)) fields[k] = '';
    return { fields, body };
}

export const wiki = (id) => `[[${id}]]`;
export const unwiki = (s) => String(s || '').replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();

/** Plain text as a markdown blockquote, so verbatim words stand apart. */
export function quote(text) {
    return String(text || '').split('\n').map((l) => '> ' + l).join('\n');
}

export function unquote(text) {
    return String(text || '').split('\n').map((l) => l.replace(/^> ?/, '')).join('\n').trim();
}

/** Body sections keyed by their bold label line: "**Done**" -> "Done". */
export function sections(body, labels) {
    const out = {};
    const lines = String(body || '').split('\n');
    let key = null;
    const pattern = new RegExp(`^\\*\\*(${labels.join('|')})\\*\\*`);
    for (const line of lines) {
        const m = line.match(pattern);
        if (m) { key = m[1]; out[key] = []; continue; }
        if (key) out[key].push(line);
    }
    for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
    return out;
}
