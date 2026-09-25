// ENGRAM core: session identity (D-A779). Wake mints a session; every
// later command carries it, so the Live and Sessions views can group what
// each session wrote. A command with no session named uses the newest
// session opened on this device in the last twelve hours, else the
// standing "unattributed" session for the device.

import { mintId, nowIso } from './repository.mjs';

const RECENT_MS = 12 * 3600 * 1000;

export function openSession(repo, device, { task = '', tool = '', model = '' } = {}) {
    const session = {
        id: 's-' + mintId(),
        device: device.id,
        deviceName: device.name,
        task,
        tool: tool || process.env.ENGRAM_TOOL || '',
        model: model || process.env.ENGRAM_MODEL || '',
        started: nowIso(),
        lastEngram: null,
        engrams: 0,
        decisions: 0,
        artefacts: 0,
        recalls: 0,
        recallTokens: 0,
        engramTokens: 0,
        rested: null,
    };
    repo.writeSession(session);
    return session;
}

/** Resolve the session a command belongs to. Never throws; always returns a session id. */
export function resolveSession(repo, device, explicit) {
    const id = explicit || process.env.ENGRAM_SESSION || '';
    if (id) {
        const s = repo.readSession(device.id, id);
        if (s) return s;
        // a session id from another device or a typo: keep the id, record nothing else
        return { id, device: device.id, foreign: true };
    }
    const cutoff = Date.now() - RECENT_MS;
    const recent = repo.listSessions(device.id).find((s) => !s.rested && Date.parse(s.started) > cutoff && s.id !== 'unattributed');
    if (recent) return recent;
    let un = repo.readSession(device.id, 'unattributed');
    if (!un) {
        un = { id: 'unattributed', device: device.id, deviceName: device.name, task: '(commands run without a session)', started: nowIso(), lastEngram: null, engrams: 0, decisions: 0, artefacts: 0, recalls: 0, recallTokens: 0, engramTokens: 0, rested: null };
        repo.writeSession(un);
    }
    return un;
}

/** Update counters on a session this device owns. Foreign ids are left alone. */
export function touchSession(repo, session, patch) {
    if (!session || session.foreign) return session;
    const current = repo.readSession(session.device, session.id) || session;
    const next = { ...current };
    for (const [k, v] of Object.entries(patch)) {
        if (typeof v === 'number' && typeof next[k] === 'number') next[k] += v;
        else next[k] = v;
    }
    repo.writeSession(next);
    return next;
}

export function restSession(repo, session) {
    return touchSession(repo, session, { rested: nowIso() });
}
