// ENGRAM compacting tests: a consolidation stands for the Echos it covers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

process.env.ENGRAM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'engram-compact-config-'));
process.env.ENGRAM_KEY_STORE = 'file';
process.env.ENGRAM_NO_NOTIFY = '1';

const { initRepository, engram, openContainer, sleep } = await import('../core/engram.mjs');
const { recall } = await import('../core/recall.mjs');
const { candidates, proposals, brief, consolidate, writeWithClaude, storeApiKey, COMPACT_MIN } = await import('../core/compact.mjs');

function seeded() {
    const dir = mkdtempSync(join(tmpdir(), 'engram-compact-'));
    const { repo, device } = initRepository(dir, { title: 'Compact memory' });
    openContainer(repo, 'wp', 'WP');
    const ids = [];
    for (let i = 0; i < COMPACT_MIN + 2; i++) {
        ids.push(engram(repo, { container: 'wp', stimulus: `step ${i}`, echo: `Register row ${i} was checked and the crew figure for zone ${i} settled at ${100 + i}.` }, { device, deferIndex: i < COMPACT_MIN + 1 }).id);
    }
    return { repo, device, ids };
}

test('candidates, proposals and the brief: settled uncovered Echos, twelve or more', () => {
    const { repo, ids } = seeded();
    assert.equal(candidates(repo, 'wp').length, 0, 'nothing is a week old yet');
    const all = candidates(repo, 'wp', { all: true });
    assert.equal(all.length, ids.length);
    assert.equal(proposals(repo).length, 0, 'sleep waits for the Echos to settle');
    const text = brief(repo, 'wp', all);
    assert.match(text, /Echos to consolidate into one/);
    assert.match(text, new RegExp(ids[0]));
    assert.match(text, /engram compact wp --name "<two to five words>" --echo/);
});

test('a consolidation covers its Echos: recall ranks it first and steps the originals back', () => {
    const { repo, device, ids } = seeded();
    const before = recall(repo, 'crew figure for zone 3 register row', { write: false, device });
    assert.ok(before.handed.includes(ids[3]));
    const c = consolidate(repo, 'wp', { echo: 'Across the WP register checks, rows 0 to 13 were checked and every zone crew figure settled between 100 and 113; no row is open.', covers: ids }, { device });
    assert.equal(c.kind, 'consolidation');
    assert.equal(c.links.filter((l) => l.kind === 'consolidates').length, ids.length);
    assert.deepEqual(repo.findEngram(ids[3]).back.consolidated_by, [c.id], 'the covered Echo points back');
    const after = recall(repo, 'crew figure for zone 3 register row', { write: false, device });
    assert.equal(after.handed[0], c.id, 'the consolidation comes first');
    assert.equal(candidates(repo, 'wp', { all: true }).length, 0, 'nothing left uncovered');
    assert.throws(() => consolidate(repo, 'wp', { echo: 'x', covers: [] }), /--covers/);
    assert.throws(() => consolidate(repo, 'wp', { echo: 'y '.repeat(900), covers: ids }), /under 400/);
    const other = openContainer(repo, 'other', 'Other');
    const o = engram(repo, { container: other, stimulus: 'elsewhere', echo: 'An Echo elsewhere.' }, { device });
    assert.throws(() => consolidate(repo, 'wp', { echo: 'z', covers: [o.id] }), /covers one container/);
});

test('the automatic writer asks Claude and writes what comes back', async () => {
    const { repo, device, ids } = seeded();
    let seen = null;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            seen = { auth: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: JSON.parse(body) };
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ content: [{ type: 'text', text: 'Consolidated: all fourteen register rows checked, crew figures settled.' }], usage: { input_tokens: 300, output_tokens: 20 } }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        storeApiKey('sk-test-key');
        const list = candidates(repo, 'wp', { all: true });
        const r = await writeWithClaude(repo, 'wp', list, { endpoint: `http://127.0.0.1:${server.address().port}/v1/messages`, model: 'claude-sonnet-5' });
        assert.equal(seen.auth, 'sk-test-key');
        assert.equal(seen.version, '2023-06-01');
        assert.equal(seen.body.model, 'claude-sonnet-5');
        assert.match(seen.body.messages[0].content, new RegExp(ids[0]));
        assert.match(r.text, /^Consolidated/);
        const c = consolidate(repo, 'wp', { echo: r.text, covers: list.map((e) => e.id) }, { device });
        assert.equal(c.links.length, list.length);
        const s = sleep(repo);
        assert.ok(Array.isArray(s.proposals));
    } finally {
        server.close();
    }
});
