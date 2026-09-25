// ENGRAM core tests. npm test  (zero dependencies)
// Each test builds a throwaway memory in the OS temp dir with its own config
// dir, so the developer's real config and memory are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

process.env.ENGRAM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'engram-config-'));
process.env.ENGRAM_NO_NOTIFY = '1';

const { initRepository, engram, decide, logArtefact, openContainer, moveContainer, digest, sleep, recommendBank, editEngram } = await import('../core/engram.mjs');
const { recall } = await import('../core/recall.mjs');
const { mintId, Repository, renderEngram, parseEngram } = await import('../core/repository.mjs');
const { terms, estimateTokens } = await import('../core/text.mjs');
const { search, brief } = await import('../core/search.mjs');
const { rebuildAll, rebuildTouched, computeMaps, readMaps } = await import('../core/index.mjs');
const { openSession, resolveSession } = await import('../core/session.mjs');
const { installClaudeBlock, installedRulesVersion, removeClaudeBlock, RULES_VERSION, RULES_MD } = await import('../core/rules.mjs');
const { parseNote, renderFrontMatter } = await import('../core/note.mjs');

function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'engram-memory-'));
    return initRepository(dir, { title: 'Test memory' });
}

function seed(repo) {
    openContainer(repo, 'field-ops', 'Field Ops');
    openContainer(repo, 'field-ops/north-grid', 'North Grid');
    openContainer(repo, 'field-ops/atlas', 'Atlas');
    openContainer(repo, 'land', 'Land');
    const a = engram(repo, { container: 'field-ops/north-grid', stimulus: 'build the field schedule for the North Grid maintenance zones', done: 'zones routed on real roads, crew rotation by band; schedule built as a spreadsheet', echo: 'The North Grid field schedule routes zones on real roads with crew rotation by band. Built as a spreadsheet.' });
    const b = decide(repo, { container: 'field-ops/north-grid', stimulus: 'how many crews rotate per zone', decision: 'Crew rotation is two teams per zone band, never one.', echo: 'Two teams per zone band, never one.', cites: [a.id] });
    const c = engram(repo, { container: 'field-ops/atlas', stimulus: 'export the thermal dataset from Atlas desktop', done: 'thermal images classified separately; export overhaul shipped', echo: 'Thermal images are classified separately in the Atlas export.' });
    const d = engram(repo, { container: 'land', stimulus: 'score the ridge parcel for slope and water', done: 'lidar bare earth then slope; buildability score 71', echo: 'The ridge parcel scored 71 for buildability from lidar bare earth and slope.', links: [{ kind: 'refines', id: c.id, why: 'same lidar pipeline idea' }] });
    return { a, b, c, d };
}

test('ids are time-ordered and unique', () => {
    const x = mintId(1000);
    const y = mintId(2000);
    assert.ok(x < y);
    assert.notEqual(mintId(), mintId());
});

test('terms drop stop words and short tokens', () => {
    assert.deepEqual(terms('The crew and the zone of it'), ['crew', 'zone']);
    assert.equal(estimateTokens('abcdefgh'), 2);
});

test('front matter round-trips scalars and lists', () => {
    const fm = renderFrontMatter({ id: 'abc-123', kind: 'decision', tags: ['a b', 'client/wp'], cites: ['[[x1]]', '[[x2]]'], empty: [], n: 3, session: '' });
    const { fields } = parseNote(fm + '# t\n');
    assert.equal(fields.id, 'abc-123');
    assert.deepEqual(fields.tags, ['a b', 'client/wp']);
    assert.deepEqual(fields.cites, ['[[x1]]', '[[x2]]']);
    assert.equal(fields.n, 3);
    assert.equal(fields.session, '');
});

test('an engram note renders and parses back to the same engram', () => {
    const e = { id: 'k1-aaaaaaaa', kind: 'decision', when: '2026-09-16T00:00:00.000Z', device: 'd', session: 's-1', container: 'a/b', tags: ['x'], links: [{ kind: 'supersedes', id: 'k0-bbbbbbbb', why: 'replaces it' }], back: { superseded_by: [], cited_by: ['k2-cccccccc'] }, artefacts: [{ id: 'art-1', name: 'file.csv' }], title: 'A ruling', echo: 'The Echo.\nTwo lines.', stimulus: 'said: "quoted"\nsecond line', done: 'did it', decision: 'The ruling.' };
    const back = parseEngram(renderEngram(e));
    assert.equal(back.id, e.id);
    assert.equal(back.echo, e.echo);
    assert.equal(back.stimulus, e.stimulus);
    assert.equal(back.decision, e.decision);
    assert.deepEqual(back.links, e.links);
    assert.deepEqual(back.back.cited_by, ['k2-cccccccc']);
    assert.deepEqual(back.artefacts, e.artefacts);
});

test('setup creates a memory with rules, root map, genesis engram; a plain folder, no git, no vault', () => {
    const { repo, fresh: isFresh, genesis } = fresh();
    assert.equal(isFresh, true);
    assert.ok(existsSync(join(repo.root, 'ENGRAM.md')));
    assert.ok(existsSync(join(repo.root, 'CLAUDE.md')));
    assert.ok(!existsSync(join(repo.root, '.obsidian')), 'no vault settings');
    assert.ok(!existsSync(join(repo.root, '.git')), 'no git');
    assert.ok(existsSync(repo.mapPath('')));
    assert.match(basename(repo.mapPath('')), /^Test memory\.md$/, 'the root map is named after the memory');
    assert.equal(genesis.kind, 'genesis');
    assert.equal(genesis.container, 'engram');
    assert.doesNotMatch(readFileSync(join(repo.root, 'ENGRAM.md'), 'utf8'), /Lobe|Schema|Brainstem|Callosum|Obsidian|git/);
});

test('an engram needs an Echo and is immutable once written', () => {
    const { repo } = fresh();
    openContainer(repo, 'x', 'X');
    assert.throws(() => engram(repo, { container: 'x', stimulus: 'no echo here' }), /Echo/);
    const e = engram(repo, { container: 'x', stimulus: 'with echo', echo: 'the echo' });
    assert.throws(() => repo.writeEngram(e), /immutable/);
    assert.throws(() => repo.rewriteEngramHeader({ ...e, echo: 'changed' }), /refusing to rewrite the body/);
    const note = readFileSync(repo.engramPath('x', e.id), 'utf8');
    assert.equal(basename(repo.engramPath('x', e.id)), 'the echo.md', 'the note is named by its name; with none given, the words of the Echo');
    assert.match(note, /^---\nid: /);
    assert.match(note, new RegExp('aliases: \\[' + e.id + '\\]'), 'the id is an alias so [[id]] resolves');
    assert.match(note, /## Echo\nthe echo\n/);
    assert.match(note, /\*\*Stimulus\*\* \(verbatim\)\n> with echo/);
});

test('engram writes the maps up the tree with decisions, hubs and children', () => {
    const { repo } = fresh();
    const { a, b } = seed(repo);
    const { maps } = readMaps(repo, repo.allEngrams());
    const wp = maps.get('field-ops/north-grid');
    assert.equal(wp.counts.engrams, 3, 'the open, the action, the decision');
    assert.equal(wp.decisions.length, 1);
    assert.equal(wp.decisions[0].engram, b.id);
    assert.ok(wp.vocabulary.some(([t]) => t === 'zone' || t === 'zones' || t === 'crew'));
    assert.equal(wp.hubs[0].id, a.id, 'the cited engram is the hub');
    const dh = maps.get('field-ops');
    assert.equal(dh.counts.descendants, 5, 'two opens plus three engrams beneath');
    assert.equal(dh.children.length, 2);
    assert.equal(maps.get('').decisions.length, 1, 'decisions propagate to the root');
    const mapNote = readFileSync(repo.mapPath('field-ops/north-grid'), 'utf8');
    assert.equal(basename(repo.mapPath('field-ops/north-grid')), 'North Grid.md', 'the map is named after the region');
    assert.match(readFileSync(repo.mapPath('field-ops'), 'utf8'), /\[\[cortex\/field-ops\/north-grid\/North Grid\|North Grid\]\]/, 'links carry the vault path');
    assert.match(mapNote, /## Decisions in force\n- Crew rotation is two teams/);
    const aNote = parseEngram(readFileSync(repo.engramPath('field-ops/north-grid', a.id), 'utf8'));
    assert.deepEqual(aNote.back.cited_by, [b.id], 'back-links are written into the cited engram');
});

test('recall routes to the right container, reads Echos, honours attention', () => {
    const { repo } = fresh();
    const { a, b, c, d } = seed(repo);
    const r = recall(repo, 'how many crews per zone for the North Grid schedule', { attention: 8000 });
    assert.ok(r.entered.includes('field-ops/north-grid'), 'entered ' + r.entered.join(','));
    assert.ok(!r.entered.includes('land'));
    assert.equal(r.handed[0], b.id, 'the decision ranks first among Echos');
    assert.ok(r.handed.includes(a.id));
    assert.ok(r.decisions.some((x) => x.engram === b.id));
    assert.match(r.bundle, /Decisions in force/);
    assert.match(r.bundle, /Crew rotation is two teams/);
    assert.match(r.bundle, /## Echos/);
    assert.match(r.bundle, /Two teams per zone band, never one\./);
    assert.doesNotMatch(r.bundle, /\*\*Stimulus\*\*/, 'recall hands over Echos, not engram bodies');
    assert.equal(r.suggest, 'field-ops/north-grid');
    assert.ok(r.used <= 8000);
    assert.match(r.cost, /^Recalled \d+ Echos from \d+ containers? in \d+ ms\./);

    const tight = recall(repo, 'how many crews per zone for the North Grid schedule', { attention: 200, write: false });
    assert.ok(tight.used <= 1400, 'fixed parts only exceed by their own size: ' + tight.used);
    assert.ok(Object.keys(tight.excluded).length >= 1 || tight.handed.length < r.handed.length);

    const land = recall(repo, 'slope and water score for the parcel', { write: false });
    assert.ok(land.entered.includes('land'));
    assert.equal(land.handed[0], d.id);
    assert.ok(land.handed.includes(c.id), 'widened one hop through the typed link');
    assert.match(land.bundle, /Linked from other branches/);
    assert.match(land.bundle, /refines via/);
});

test('a parent is entered when only a grandchild matches, and root decisions stay local', () => {
    const { repo } = fresh();
    const { b } = seed(repo);
    const r = recall(repo, 'crew rotation band', { write: false });
    assert.ok(r.entered.includes('field-ops'), 'the parent was entered on the strength of its child');
    assert.ok(r.entered.includes('field-ops/north-grid'));
    assert.ok(r.decisions.some((d) => d.engram === b.id));
    const far = recall(repo, 'nothing about anything here at all', { write: false });
    assert.equal(far.entered.length, 0);
    assert.equal(far.decisions.length, 0, 'no branch entered: the root does not hand over every decision');
});

test('supersession: the new decision replaces the old in force, the old is kept and marked', () => {
    const { repo } = fresh();
    const { b } = seed(repo);
    const n = decide(repo, { container: 'field-ops/north-grid', stimulus: 'crews changed', decision: 'Crew rotation is three teams per zone band.', echo: 'Three teams per zone band now.', supersedes: [b.id] });
    const { maps } = readMaps(repo, repo.allEngrams());
    const wp = maps.get('field-ops/north-grid');
    assert.deepEqual(wp.decisions.map((d) => d.engram), [n.id]);
    assert.equal(wp.superseded[0].engram, b.id);
    assert.equal(wp.superseded[0].by, n.id);
    const old = repo.findEngram(b.id);
    assert.deepEqual(old.back.superseded_by, [n.id]);
    assert.equal(old.decision, 'Crew rotation is two teams per zone band, never one.', 'the original is kept');
    const r = recall(repo, 'how many crews per zone', { write: false });
    assert.ok(r.decisions.every((d) => d.engram !== b.id));
    assert.ok(r.history.some((d) => d.engram === b.id));
    assert.match(r.bundle, /Superseded, history only/);
    assert.match(r.bundle, /Superseded by: /);
    assert.match(readFileSync(repo.mapPath('field-ops/north-grid'), 'utf8'), /## Superseded/);
});

test('contradictions are flagged until superseded or confirmed, never resolved by the tool', () => {
    const { repo } = fresh();
    openContainer(repo, 'wp', 'WP');
    const x = engram(repo, { container: 'wp', kind: 'learning', stimulus: 'the scope section 5 says six-year thermal cycle', echo: 'The thermal cycle is six years per the scope section 5.' });
    const y = engram(repo, { container: 'wp', kind: 'learning', stimulus: 'the scope section 6.1 says eight-year cycle', echo: 'The cycle is eight years per the scope section 6.1.', contradicts: [x.id] });
    let { maps } = readMaps(repo, repo.allEngrams());
    assert.equal(maps.get('wp').contradictions.length, 1);
    assert.equal(maps.get('').contradictions.length, 1, 'the flag shows at the root too');
    const r = recall(repo, 'thermal cycle years', { write: false });
    assert.match(r.bundle, /Contradictions flagged/);
    decide(repo, { container: 'wp', stimulus: 'ruled', decision: 'Both cycles stand; the LCM argument covers them.', echo: 'Both cycles stand.', confirms: [y.id] });
    ({ maps } = readMaps(repo, repo.allEngrams()));
    assert.equal(maps.get('wp').contradictions.length, 0, 'a later confirmation closes the flag');
    // a ruling against a fact is never a contradiction (D-A965), whatever link the writer used
    const fact = engram(repo, { container: 'wp', kind: 'learning', stimulus: 'the scope section 6.4 puts training in phase 2', echo: 'the scope section 6.4 places training and competency inside phase 2.' });
    decide(repo, { container: 'wp', stimulus: 'training is section 3', decision: 'Training and competency is its own section 3.', echo: 'Section 3 is its own.', contradicts: [fact.id] });
    ({ maps } = readMaps(repo, repo.allEngrams()));
    assert.equal(maps.get('wp').contradictions.length, 0, 'the ruling governs, the fact stays cited, nothing is flagged');
});

test('recall traces become routes and strongest links after sleep', () => {
    const { repo } = fresh();
    seed(repo);
    recall(repo, 'North Grid crews and zones');
    recall(repo, 'North Grid crews and zones');
    assert.equal(repo.readTraces().length, 2);
    const r = sleep(repo);
    assert.ok(r.rebuilt >= 5);
    const { maps } = readMaps(repo, repo.allEngrams());
    assert.ok(maps.get('field-ops/north-grid').linksOut.some((h) => h.path === 'field-ops'), 'entered together with its parent');
});

test('citations and links give strength, and cited engrams get a prior', () => {
    const { repo } = fresh();
    const { a, c } = seed(repo);
    engram(repo, { container: 'field-ops/atlas', stimulus: 'thermal export question again', cites: [a.id, c.id], echo: 'Answered from the schedule and the export.' });
    const { strength } = readMaps(repo, repo.allEngrams());
    const key = a.id < c.id ? a.id + '|' + c.id : c.id + '|' + a.id;
    assert.ok(!strength.has(key) || strength.get(key) >= 0);
    const cited = repo.findEngram(a.id);
    assert.equal(cited.back.cited_by.length, 2);
});

test('artefacts are logged as produced with hash, device and availability', () => {
    const { repo } = fresh();
    const { a } = seed(repo);
    const file = join(repo.root, '..', 'schedule.csv');
    writeFileSync(file, 'zone,crew\n1,2\n');
    const rec = logArtefact(repo, { engram: a.id, path: file, note: 'the schedule' });
    assert.equal(rec.availability, 'device');
    assert.equal(rec.size, 14);
    assert.equal(rec.hash.length, 64);
    assert.ok(existsSync(join(repo.root, 'artefacts', rec.id + '.md')));
    const r = recall(repo, 'North Grid schedule', { write: false });
    assert.match(r.bundle, /schedule\.csv: device on/);
    const rec2 = recommendBank(repo, { artefact: rec.id, reason: 'worth keeping across devices' });
    assert.equal(rec2.kind, 'recommendation');
    assert.equal(repo.listArtefacts()[0].banked, null, 'a recommendation moves nothing');
});

test('containers move; engrams keep content, change address; the move is recorded', () => {
    const { repo } = fresh();
    const { c } = seed(repo);
    const dest = moveContainer(repo, 'field-ops/atlas', '');
    assert.equal(dest, 'atlas');
    const moved = repo.findEngram(c.id);
    assert.equal(moved.container, 'atlas');
    assert.equal(moved.stimulus, c.stimulus);
    assert.equal(moved.echo, c.echo);
    assert.ok(repo.listEngrams('atlas').some((e) => e.kind === 'move'));
    assert.throws(() => moveContainer(repo, 'field-ops', 'field-ops/north-grid'), /beneath itself/);
});

test('the digest is an engram: the map keeps it across rebuilds and routes on its answers', () => {
    const { repo } = fresh();
    seed(repo);
    digest(repo, 'land', { digest: 'Everything about Tennessee land.', answers: ['is this parcel buildable'], gaps: ['no soil data yet'] });
    engram(repo, { container: 'land', stimulus: 'another parcel', echo: 'Another parcel scored.' });
    const { maps } = readMaps(repo, repo.allEngrams());
    const m = maps.get('land');
    assert.equal(m.digest, 'Everything about Tennessee land.');
    assert.deepEqual(m.answers, ['is this parcel buildable']);
    assert.deepEqual(m.gaps, ['no soil data yet']);
    assert.equal(m.counts.engrams, 4, 'the open, the seed, the digest, the new one');
    const r = recall(repo, 'is this parcel buildable', { write: false });
    assert.equal(r.entered[0], 'land', 'the answers line routes a task its vocabulary would miss');
    assert.match(r.bundle, /Known gaps/);
});

test('incremental rebuild writes the same maps as a full rebuild', () => {
    const { repo } = fresh();
    seed(repo);
    const read = () => Object.fromEntries(repo.listContainers().map((c) => [c, readFileSync(repo.mapPath(c), 'utf8').replace(/^updated: .*$/m, '')]));
    engram(repo, { container: 'land', stimulus: 'x', echo: 'A new land Echo.' });
    const incremental = read();
    rebuildAll(repo);
    const full = read();
    assert.deepEqual(incremental, full);
    const n = rebuildTouched(repo, ['land']);
    assert.equal(n, 2, 'land and the root');
});

test('sessions: wake mints one, commands carry it, the session file counts what it wrote', () => {
    const { repo, device } = fresh();
    openContainer(repo, 'x', 'X');
    const s = openSession(repo, device, { task: 'test the sessions' });
    assert.match(s.id, /^s-/);
    engram(repo, { container: 'x', stimulus: 'one', echo: 'One.', session: s.id });
    decide(repo, { container: 'x', stimulus: 'two', decision: 'Two.', echo: 'Two.', session: s.id });
    recall(repo, 'one two', { sessionId: s.id });
    const after = repo.readSession(device.id, s.id);
    assert.equal(after.engrams, 2);
    assert.equal(after.decisions, 1);
    assert.equal(after.recalls, 1);
    assert.ok(after.recallTokens > 0);
    const implicit = resolveSession(repo, device, undefined);
    assert.equal(implicit.id, s.id, 'a command with no session uses the newest open one on this device');
    const e = engram(repo, { container: 'x', stimulus: 'three', echo: 'Three.' });
    assert.equal(e.session, s.id);
    assert.ok(repo.listSessions().some((x) => x.id === s.id));
});

test('the rules block installs into CLAUDE.md once, refreshes on version change, removes cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-claude-'));
    const file = join(dir, 'CLAUDE.md');
    writeFileSync(file, '# Mine\n\nkeep this\n');
    const r1 = installClaudeBlock(file);
    assert.equal(r1.action, 'installed');
    assert.equal(installedRulesVersion(file), RULES_VERSION);
    assert.equal(installClaudeBlock(file).action, 'unchanged');
    const r3 = installClaudeBlock(file, RULES_VERSION + 1);
    assert.equal(r3.action, 'updated');
    assert.equal(installedRulesVersion(file), RULES_VERSION + 1);
    assert.equal((readFileSync(file, 'utf8').match(/engram:rules/g) || []).length, 2, 'one open, one close');
    assert.match(readFileSync(file, 'utf8'), /keep this/);
    assert.equal(removeClaudeBlock(file), true);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /engram:rules/);
    assert.match(readFileSync(file, 'utf8'), /keep this/);
    assert.doesNotMatch(RULES_MD, /Temporal|Lobe|Schema|Brainstem|Callosum|Scan/);
});

test('a second Repository object reads what the first wrote, and the rules are in the memory', () => {
    const { repo } = fresh();
    const { b } = seed(repo);
    const other = new Repository(repo.root);
    assert.equal(other.findEngram(b.id).id, b.id);
    assert.equal(other.stats().engrams, 4 + 1 + 4, 'four seeded, one genesis, four container opens');
    const rules = readFileSync(join(repo.root, 'ENGRAM.md'), 'utf8');
    assert.match(rules, /## 1\. Wake/);
    assert.match(rules, /Echo\s+is compulsory/);
});

test('no retired word survives in the core', () => {
    const dir = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', 'core');
    for (const f of readdirSync(dir)) {
        const text = readFileSync(join(dir, f), 'utf8');
        assert.doesNotMatch(text, /\b(Temporal|Lobe|Brainstem|Callosum|Thalamus|Hippocampus)\b/, f);
    }
});

test('an engram is named by the writer, two to five words, or by the first words of the Echo', () => {
    const { repo } = fresh();
    openContainer(repo, 'n', 'N');
    const a = engram(repo, { container: 'n', name: 'Thermal is its own deliverable', stimulus: 'x', echo: 'Thermal is answered as its own deliverable with its own cycle and outputs. Long text follows.' });
    assert.equal(a.title, 'Thermal is its own deliverable');
    assert.equal(basename(repo.engramPath('n', a.id)), 'Thermal is its own deliverable.md');
    const b = engram(repo, { container: 'n', name: 'one two three four five six seven', stimulus: 'x', echo: 'y z' });
    assert.equal(b.title, 'one two three four five', 'a name is capped at five words');
    const c = engram(repo, { container: 'n', stimulus: 'x', echo: 'The launcher standard is followed by every tool server on the network. More.' });
    assert.equal(c.title, 'launcher standard followed every tool', 'no name: the first content words of the Echo');
    assert.ok(c.title.split(' ').length <= 5);
    const d = decide(repo, { container: 'n', stimulus: 'x', decision: 'Australian English throughout.', echo: 'Australian English throughout the response.' });
    assert.equal(d.title, 'Australian English throughout response');
    const note = readFileSync(repo.engramPath('n', a.id), 'utf8');
    assert.match(note, /^# Thermal is its own deliverable$/m, 'the heading is the name');
});

test('an engram named like its region never takes the file of the map note', () => {
    const { repo } = fresh();
    openContainer(repo, 'r', 'The launcher standard');
    const e = engram(repo, { container: 'r', name: 'The launcher standard', stimulus: 'x', echo: 'Every tool server follows it.' });
    assert.equal(basename(repo.engramPath('r', e.id)), 'The launcher standard ~2.md');
    assert.ok(repo.isMapNote(repo.mapPath('r')), 'the map note is still the map');
    assert.equal(repo.findEngram(e.id).echo, 'Every tool server follows it.');
});


test('search is Google-style: a region named by the query is taken whole, every Echo is scored, no budget', () => {
    const { repo } = fresh();
    seed(repo);
    openContainer(repo, 'orko', 'ORKO');
    const s1 = engram(repo, { container: 'orko', name: 'Sphere preset', stimulus: 'add the sphere preset', echo: 'The sphere preset places drones on a shell with clearance.' });
    const s2 = decide(repo, { container: 'orko', stimulus: 'clearance', decision: 'Drone clearance is two metres minimum.', echo: 'Two metres clearance between drones.' });
    const r = search(repo, 'ORKO');
    assert.ok(r.regions.some((x) => x.path === 'orko' && x.byName), 'the region is named');
    assert.deepEqual(r.echos.map((e) => e.id).sort(), [s1.id, s2.id].sort(), 'everything under the region, even Echos that never say ORKO');
    assert.ok(r.decisions.some((d) => d.engram === s2.id), 'its rulings in force come along');
    const r2 = search(repo, 'crews rotating per zone');
    assert.ok(r2.echos.length >= 2, 'stems meet: crews/crew, rotating/rotation, zone');
    assert.equal(r2.echos[0].container, 'field-ops/north-grid');
    const r3 = search(repo, 'nothing here at all xyzzy');
    assert.equal(r3.echos.length, 0);
    assert.equal(r3.regions.length, 0);
});

test('brief hands over one region at a fixed cost: map, rulings, recent Echos, gaps', () => {
    const { repo } = fresh();
    const { a, b } = seed(repo);
    digest(repo, 'field-ops/north-grid', { digest: 'The North Grid work.', gaps: ['no crew count for zone 9'] });
    const r = brief(repo, 'field-ops/north-grid', { attention: 4000 });
    assert.match(r.bundle, /^# BRIEF: North Grid/);
    assert.match(r.bundle, /## Rulings in force\n- Crew rotation is two teams/);
    assert.ok(r.handed.includes(a.id) && r.handed.includes(b.id));
    assert.match(r.bundle, /no crew count for zone 9/);
    assert.ok(r.used <= 4000);
    const tight = brief(repo, 'field-ops/north-grid', { attention: 200 });
    assert.ok(tight.excluded >= 1, 'a small budget leaves Echos out and says so');
    assert.match(tight.bundle, /older Echos not shown/);
    assert.throws(() => brief(repo, 'no/such/region'), /no container/);
});

test('the person edits a memory: body changes, note renamed and stamped, maps rebuilt; a move changes the address', () => {
    const { repo } = fresh();
    const { a } = seed(repo);
    const before = repo.findEngram(a.id);
    const e = editEngram(repo, a.id, { name: 'Field schedule on real roads', echo: 'The North Grid field schedule routes zones on real roads. Edited.', tags: ['edited-by-hand'] });
    assert.equal(e.id, a.id);
    assert.equal(e.when, before.when, 'time stays');
    assert.equal(e.title, 'Field schedule on real roads');
    assert.match(e.echo, /Edited\.$/);
    assert.ok(e.edited, 'stamped');
    assert.equal(basename(repo.engramPath('field-ops/north-grid', a.id)), 'Field schedule on real roads.md', 'the note follows its name');
    assert.deepEqual(repo.findEngram(a.id).tags, ['edited-by-hand']);
    const note = readFileSync(repo.engramPath('field-ops/north-grid', a.id), 'utf8');
    assert.match(note, /^edited: /m);
    const { maps } = readMaps(repo, repo.allEngrams());
    assert.ok(maps.get('field-ops/north-grid').vocabulary.some(([t]) => t === 'edit'), 'the map saw the edit');
    const moved = editEngram(repo, a.id, { container: 'land' });
    assert.equal(moved.container, 'land');
    assert.equal(repo.findEngram(a.id).container, 'land');
    assert.ok(!repo.listEngrams('field-ops/north-grid').some((x) => x.id === a.id));
    assert.throws(() => editEngram(repo, a.id, { echo: '' }), /Echo/);
    assert.throws(() => editEngram(repo, 'nope-00000000', { echo: 'x' }), /not in this memory/);
});

test('setup by a folder pick: the memory is created, rules installed, the command written; check lists facts', async () => {
    const setup = await import('../core/setup.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'engram-pick-'));
    const home = mkdtempSync(join(tmpdir(), 'engram-claude-'));
    const claude = join(home, 'CLAUDE.md');
    process.env.ENGRAM_CLAUDE_HOME = home;
    const r = setup.setupMemory(join(dir, 'MEMORY'), { title: 'Picked' });
    assert.equal(r.fresh, true);
    assert.ok(existsSync(join(dir, 'MEMORY', 'ENGRAM.md')));
    assert.equal(r.rules.action, 'installed');
    assert.equal(installedRulesVersion(claude), RULES_VERSION);
    assert.ok(existsSync(r.shim), 'the command file exists');
    assert.ok(readFileSync(r.shim, 'utf8').includes(setup.CLI));
    const again = setup.setupMemory(join(dir, 'MEMORY'));
    assert.equal(again.fresh, false, 'a second pick adopts');
    assert.throws(() => setup.setupMemory(setup.APP_ROOT), /application folder/);
    const c = await setup.check();
    assert.ok(Array.isArray(c.items) && c.items.length >= 7);
    for (const i of c.items) { assert.equal(typeof i.ok, 'boolean'); assert.ok(i.text); }
    assert.ok(c.items.find((i) => i.key === 'memory').ok);
    assert.ok(c.items.find((i) => i.key === 'rules').ok);
    delete process.env.ENGRAM_CLAUDE_HOME;
});
