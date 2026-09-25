// ENGRAM core: the write path. Set up a memory, engram an action, record a
// decision, log an artefact, recommend a bank, write a digest, open or
// move a container, sleep; and the person's own add and edit from the page. Every write ends by rebuilding the maps it
// touched and telling the always-on server, so the memory is a little
// sharper after each action.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { Repository, KINDS, STRUCTURAL, LINK_KINDS, mintId, nowIso, thisDevice, writeConfig, normalizeContainerPath } from './repository.mjs';
import { RULES_MD, CLAUDE_MD, RULES_VERSION } from './rules.mjs';
import { rebuildAll, rebuildTouched } from './index.mjs';
import { notify } from './notify.mjs';
import { estimateTokens, firstLine, shortName, capName } from './text.mjs';
import { resolveSession, touchSession } from './session.mjs';
import { proposals as compactProposals } from './compact.mjs';

export const GENESIS_CONTAINER = 'engram';

/** Create a new memory at dir (or adopt an existing one) and select it. */
export function initRepository(dir, { title, device: dev } = {}) {
    const root = resolve(dir);
    const repo = new Repository(root);
    const fresh = !repo.exists();
    repo.scaffold();
    const device = dev || thisDevice();
    repo.writeDevice({ ...device, artefactRoot: process.cwd() });
    if (!existsSync(resolve(root, 'ENGRAM.md'))) writeFileSync(resolve(root, 'ENGRAM.md'), RULES_MD, 'utf8');
    if (!existsSync(resolve(root, 'CLAUDE.md'))) writeFileSync(resolve(root, 'CLAUDE.md'), CLAUDE_MD, 'utf8');
    if (title) repo.writeTitle('', title);
    writeConfig({ repository: root });
    let genesis = null;
    if (fresh) {
        repo.openContainer(GENESIS_CONTAINER);
        repo.writeTitle(GENESIS_CONTAINER, 'Engram itself');
        genesis = engram(repo, {
            container: GENESIS_CONTAINER,
            kind: 'genesis',
            name: 'Memory born',
            stimulus: `engram setup ${root}`,
            done: `A new memory was created on device ${device.name} (${device.id}) with rules version ${RULES_VERSION}.`,
            echo: `This memory${title ? ', ' + title + ',' : ''} was born ${nowIso().slice(0, 10)} on ${device.name}.`,
            tags: ['genesis'],
        }, { device, full: true });
    } else {
        rebuildAll(repo);
    }
    return { repo, fresh, device, genesis };
}

function normalizeLinks(repo, fields) {
    const links = [];
    const add = (kind, raw) => {
        for (const l of [].concat(raw || [])) {
            if (!l) continue;
            const id = typeof l === 'string' ? l : l.id;
            const why = typeof l === 'string' ? '' : l.why || '';
            if (!LINK_KINDS.includes(kind)) throw new Error(`unknown link kind "${kind}" (one of ${LINK_KINDS.join(', ')})`);
            if (!repo.findEngram(id)) throw new Error(`link target ${id} is not an engram in this memory`);
            if (!links.some((x) => x.kind === kind && x.id === id)) links.push({ kind, id, why });
        }
    };
    for (const l of fields.links || []) add(l.kind || 'cites', l);
    for (const k of LINK_KINDS) if (fields[k]) add(k, fields[k]);
    return links;
}

/**
 * Write one engram. Required: container (must exist unless open is set),
 * stimulus, and an Echo for every non-structural kind. Immutable after this.
 */
export function engram(repo, fields, options = {}) {
    const container = normalizeContainerPath(fields.container);
    if (!repo.hasContainer(container)) {
        if (fields.open) { repo.openContainer(container); if (fields.title) repo.writeTitle(container, fields.title); }
        else throw new Error(`no container "${container || 'root'}". Open it first: engram cortex open ${container} --title "..."`);
    }
    const kind = fields.kind || (fields.decision ? 'decision' : 'action');
    if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (one of ${KINDS.join(', ')})`);
    if (!fields.stimulus || !String(fields.stimulus).trim()) throw new Error('an engram needs a stimulus: what was asked or what happened, verbatim');
    const structural = STRUCTURAL.has(kind);
    if (!structural && (!fields.echo || !String(fields.echo).trim())) throw new Error('an engram needs an Echo (--echo): what a future session needs to know, in a few lines. An engram without one has not been written.');
    if (kind === 'decision' && !fields.decision) throw new Error('a decision needs --decision "<the ruling>"');
    const device = options.device || thisDevice();
    const session = options.session || resolveSession(repo, device, fields.session);
    const links = normalizeLinks(repo, fields);
    const when = nowIso();
    const e = {
        id: mintId(),
        kind,
        when,
        device: device.id,
        session: session.id,
        container,
        tags: (fields.tags || []).map(String).filter(Boolean),
        links,
        back: {},
        artefacts: fields.artefacts || [],
        // the name: two to five words the writer chose (--name); derived from the Echo only when none was given
        title: capName(fields.name) || shortName(fields.echo || fields.decision || fields.stimulus),
        echo: String(fields.echo || '').trim(),
        stimulus: String(fields.stimulus),
        done: String(fields.done || '').trim(),
        decision: String(fields.decision || '').trim(),
    };
    repo.writeEngram(e);
    const tokens = estimateTokens([e.echo, e.stimulus, e.done, e.decision].join('\n'));
    repo.appendLedger(device.id, { when, action: 'engram', engram: e.id, container, kind, session: session.id, tokens });
    if (!structural) touchSession(repo, session, { lastEngram: when, engrams: 1, decisions: kind === 'decision' ? 1 : 0, engramTokens: tokens });
    if (!options.deferIndex) {
        if (options.full) rebuildAll(repo); else rebuildTouched(repo, [container]);
        notify({ type: 'engram', id: e.id, kind, container, session: session.id, device: device.id, line: firstLine(e.echo || e.decision || e.stimulus, 100) });
    }
    return e;
}

export function decide(repo, fields, options) {
    if (!fields.decision) throw new Error('a decision needs --decision "<the ruling>"');
    return engram(repo, { ...fields, kind: 'decision' }, options);
}

/** Log a file as produced: hash, size, device, path. The bytes stay where they are. */
export function logArtefact(repo, { engram: engramId, path, note, availability, session: sessionId }, options = {}) {
    const abs = resolve(path);
    if (!existsSync(abs)) throw new Error(`no file at ${abs}`);
    const e = repo.findEngram(engramId);
    if (!e) throw new Error(`engram ${engramId} is not in this memory`);
    const device = options.device || thisDevice();
    const session = options.session || resolveSession(repo, device, sessionId);
    const st = statSync(abs);
    const hash = st.isFile() ? createHash('sha256').update(readFileSync(abs)).digest('hex') : '';
    const record = {
        id: mintId(),
        engram: engramId,
        container: e.container,
        name: basename(abs),
        path: abs,
        device: device.id,
        size: st.size,
        hash,
        isDirectory: st.isDirectory(),
        availability: availability || 'device',
        banked: null,
        note: note || '',
        when: nowIso(),
    };
    repo.writeArtefact(record);
    repo.appendLedger(device.id, { when: record.when, action: 'log', artefact: record.id, engram: engramId, bytes: st.size, session: session.id });
    touchSession(repo, session, { artefacts: 1 });
    notify({ type: 'artefact', id: record.id, engram: engramId, container: e.container, session: session.id, device: device.id, line: record.name });
    return record;
}

/** The AI's recommendation to bank: written as an engram, nothing moves (D-A740). */
export function recommendBank(repo, { artefact, reason, container, session }, options) {
    const a = repo.findArtefact(artefact);
    if (!a) throw new Error(`artefact ${artefact} is not in this memory`);
    return engram(repo, {
        container: container || a.container,
        kind: 'recommendation',
        stimulus: `recommend banking ${a.name} (${a.id})`,
        done: 'Recommendation only. The person decides whether it goes to long-term storage.',
        echo: `Doc recommends banking ${a.name}${reason ? ': ' + reason : ''}. Not banked; the person decides.`,
        links: [{ kind: 'produced_from', id: a.engram, why: 'the engram that produced the artefact' }],
        artefacts: [{ id: a.id, name: a.name }],
        session,
    }, options);
}

/** Write the AI's digest of a container as a digest engram (latest wins). */
export function digest(repo, path, { digest: text, answers, gaps, title, session }, options) {
    const p = normalizeContainerPath(path);
    if (!repo.hasContainer(p)) throw new Error(`no container "${p || 'root'}"`);
    if (title) repo.writeTitle(p, title);
    if (text === undefined && answers === undefined && gaps === undefined) {
        rebuildTouched(repo, [p]);
        return null;
    }
    const done = [];
    if (answers && answers.length) done.push('Answers: ' + answers.join(' | '));
    if (gaps && gaps.length) done.push('Gaps: ' + gaps.join(' | '));
    return engram(repo, {
        container: p,
        kind: 'digest',
        name: capName(`Digest of ${repo.readTitle(p)}`, 6),
        stimulus: `engram digest ${p || '/'}`,
        done: done.join('\n'),
        echo: String(text || '').trim(),
        session,
    }, options);
}

/** Open a container and record the act. */
export function openContainer(repo, path, title, options) {
    const p = normalizeContainerPath(path);
    if (!p) throw new Error('the root already exists');
    const existed = repo.hasContainer(p);
    repo.openContainer(p);
    if (title) repo.writeTitle(p, title);
    if (!existed) {
        engram(repo, {
            container: p,
            kind: 'move',
            name: capName(`Opened ${title || p.split('/').pop()}`, 6),
            stimulus: `engram cortex open ${p}${title ? ' --title "' + title + '"' : ''}`,
            done: `Container ${p} opened.`,
            echo: `Opened ${title || p.split('/').pop()} (${p}).`,
        }, options);
    } else if (!(options && options.deferIndex)) {
        rebuildTouched(repo, [p]);
    }
    return p;
}

/** Move a container and record the act in its new place. */
export function moveContainer(repo, from, toParent, options) {
    const dest = repo.moveContainer(from, toParent);
    engram(repo, {
        container: dest,
        kind: 'move',
        name: capName(`Moved ${repo.readTitle(dest)}`, 6),
        stimulus: `engram cortex move ${from} ${toParent || '/'}`,
        done: `Container ${from} is now ${dest}. Engrams unchanged; only their address moved.`,
        echo: `Moved ${from} to ${dest}.`,
    }, { ...(options || {}), full: true });
    return dest;
}

/** Sleep: the scheduled pass. Mechanical only; proposals are printed, never applied. */
export function sleep(repo) {
    const n = rebuildAll(repo);
    const proposals = [];
    const list = repo.listContainers();
    const all = JSON.parse(readFileSync(join(repo.localDir, 'maps.json'), 'utf8')).maps;
    const mapOf = (c) => all[c];
    for (const c of list) {
        const m = mapOf(c);
        if (!m) continue;
        const total = m.counts.engrams + m.counts.descendants;
        if (c && m.counts.engrams > 60 && m.counts.children === 0) proposals.push(`split ${c}: ${m.counts.engrams} engrams in one container and no sub containers`);
        if (!m.digest && total > 0) proposals.push(`digest ${c || 'root'}: ${total} engrams and no digest`);
        if (m.newest && m.digestNewest && m.digestNewest < m.newest) proposals.push(`refresh digest ${c || 'root'}: newer engrams than the digest has seen`);
        for (const x of m.contradictions || []) if (!c) proposals.push(`rule on a contradiction: ${x.a} vs ${x.b}`);
    }
    for (const x of compactProposals(repo)) proposals.push(`compact ${x.container || 'root'}: ${x.count} settled Echos with no consolidation. Run: engram compact ${x.container || '/'}`);
    const containers = list.slice(1);
    for (let i = 0; i < containers.length; i++) {
        for (let j = i + 1; j < containers.length; j++) {
            const a = (mapOf(containers[i]) || { vocabulary: [] }).vocabulary.slice(0, 15).map((v) => v[0]);
            const b = (mapOf(containers[j]) || { vocabulary: [] }).vocabulary.slice(0, 15).map((v) => v[0]);
            const kin = containers[i].startsWith(containers[j] + '/') || containers[j].startsWith(containers[i] + '/');
            if (!kin && a.length >= 8 && b.length >= 8) {
                const inter = a.filter((t) => b.includes(t)).length;
                if (inter >= 10) proposals.push(`merge? ${containers[i]} and ${containers[j]} share ${inter} of their top 15 terms`);
            }
        }
    }
    return { rebuilt: n, proposals };
}

/**
 * The person's edit of one engram from the page (D-A973). The AI never
 * calls this. The id, kind, time and device stay; name, container, Echo,
 * stimulus, done, decision and tags may change; the note carries an
 * edited stamp; the maps of the old and new container are rebuilt.
 */
export function editEngram(repo, id, fields) {
    const e = repo.findEngram(id);
    if (!e) throw new Error(`engram ${id} is not in this memory`);
    const container = fields.container === undefined ? e.container : normalizeContainerPath(fields.container);
    if (!repo.hasContainer(container)) throw new Error(`no container "${container || 'root'}"`);
    const kind = fields.kind || e.kind;
    if (!KINDS.includes(kind)) throw new Error(`unknown kind "${kind}" (one of ${KINDS.join(', ')})`);
    const next = {
        ...e,
        kind,
        title: fields.name !== undefined ? (capName(fields.name) || e.title) : e.title,
        echo: fields.echo !== undefined ? String(fields.echo).trim() : e.echo,
        stimulus: fields.stimulus !== undefined ? String(fields.stimulus) : e.stimulus,
        done: fields.done !== undefined ? String(fields.done).trim() : e.done,
        decision: fields.decision !== undefined ? String(fields.decision).trim() : e.decision,
        tags: fields.tags !== undefined ? [].concat(fields.tags).map(String).filter(Boolean) : e.tags,
        edited: nowIso(),
    };
    if (!STRUCTURAL.has(next.kind) && !next.echo) throw new Error('an engram needs an Echo');
    if (next.kind === 'decision' && !next.decision) throw new Error('a decision needs the ruling in one sentence');
    if (!String(next.stimulus).trim()) throw new Error('an engram needs a stimulus');
    if (container !== e.container) {
        // the note moves folder: written fresh at the new address, the old file removed
        const oldFile = repo.engramPath(e.container, e.id);
        unlinkSync(oldFile);
        delete repo._idmap()[e.id];
        repo._saveIdmap();
        repo.writeEngram({ ...next, container });
        repo._engramCache = {};
        repo._cacheDirty = true;
    } else {
        repo.editEngram(next);
    }
    rebuildTouched(repo, [e.container, container]);
    notify({ type: 'engram', id: e.id, kind: next.kind, container, session: e.session, device: e.device, edited: true, line: firstLine(next.echo || next.decision || next.stimulus, 100) });
    return repo.findEngram(e.id);
}
