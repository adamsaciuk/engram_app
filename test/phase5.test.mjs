// ENGRAM storage tests: long-term storage (Signature V4, bank, fetch, the
// budget gate) against a fake S3 server, with the secret store as a file.
// Zero dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

process.env.ENGRAM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'engram-p5-config-'));
process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'engram-p5-local-'));
process.env.ENGRAM_KEY_STORE = 'file';
process.env.ENGRAM_NO_NOTIFY = '1';

const { initRepository, engram, openContainer, logArtefact } = await import('../core/engram.mjs');
const { sign, setStorage, storeCredentials, bank, fetchArtefact, setBudgets, readCredentialFile, usage } = await import('../core/storage.mjs');

const fresh = (device) => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-p5-memory-'));
    return initRepository(dir, { title: 'P5 memory', device });
};

test('Signature V4 produces the documented shape', () => {
    const h = sign({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', payloadHash: createHash('sha256').update('').digest('hex'), region: 'us-east-1', creds: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, now: new Date('2013-05-24T00:00:00Z') });
    assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(h['x-amz-date'], '20130524T000000Z');
});

test('a credential file is read whatever the key names, a Key Vault pack included', () => {
    const f = join(tmpdir(), 'engram-p5-creds.json');
    writeFileSync(f, JSON.stringify({ name: 'pack', s3: { AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', bucket: 'b', region: 'us-east-2', endpoint: 'https://s3.us-east-2.amazonaws.com' } }));
    const c = readCredentialFile(f);
    assert.equal(c.accessKeyId, 'AK');
    assert.equal(c.secretAccessKey, 'SK');
    assert.equal(c.bucket, 'b');
    assert.equal(c.region, 'us-east-2');
});

test('bank is refused without the person, fetch needs a reason, the budgets gate, the cache serves the second fetch', async () => {
    // a fake S3: stores objects, checks the signature shape
    const objects = new Map();
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
            if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*Signature=[0-9a-f]{64}$/.test(req.headers.authorization || '')) { res.writeHead(403).end('bad signature'); return; }
            if (req.method === 'PUT') { objects.set(req.url, Buffer.concat(chunks)); res.writeHead(200).end(); return; }
            if (req.method === 'GET') { const o = objects.get(req.url); if (!o) { res.writeHead(404).end(); return; } res.writeHead(200).end(o); return; }
            res.writeHead(405).end();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
        const { repo, device } = fresh();
        openContainer(repo, 'x', 'X');
        const e = engram(repo, { container: 'x', stimulus: 'made a file', echo: 'A file was made.' }, { device });
        const file = join(repo.root, '..', 'p5-artefact.bin');
        writeFileSync(file, Buffer.alloc(300000, 1));
        const a = logArtefact(repo, { engram: e.id, path: file, note: 'a big one' }, { device });
        setStorage(repo, { endpoint: `http://127.0.0.1:${port}`, bucket: 'brain', prefix: 'owner' });
        storeCredentials(repo, { accessKeyId: 'AK', secretAccessKey: 'SK' });

        await assert.rejects(bank(repo, a.id, { device }), /person/);
        const banked = await bank(repo, a.id, { byUser: true, device });
        assert.equal(banked.availability, 'device+storage');
        assert.equal(banked.objectKey, `owner/${a.id}/p5-artefact.bin`);
        assert.ok(objects.has(`/brain/owner/${a.id}/p5-artefact.bin`), 'the object landed under bucket/prefix');
        assert.equal(repo.findArtefact(a.id).objectKey, banked.objectKey, 'the artefact record carries the object key');
        assert.ok(repo.allEngrams().some((x) => x.kind === 'artefact' && x.stimulus.startsWith('engram bank')), 'the bank is an engram');

        await assert.rejects(fetchArtefact(repo, a.id, { device }), /reason/);
        const f1 = await fetchArtefact(repo, a.id, { reason: 'the exhibit needs it', device });
        assert.equal(f1.cached, false);
        assert.equal(f1.bytes, 300000);
        assert.ok(existsSync(f1.path));
        assert.equal(createHash('sha256').update(readFileSync(f1.path)).digest('hex'), a.hash, 'hash verified');
        const f2 = await fetchArtefact(repo, a.id, { reason: 'again', device });
        assert.equal(f2.cached, true, 'cache before bucket');
        assert.equal(seen.filter((s) => s.method === 'GET').length, 1, 'one download');
        const u = usage(repo, device.id);
        assert.equal(u.todayBytes, 300000, 'the ledger holds the spend');

        rmSync(f1.path);
        setBudgets(repo, { deviceDayMB: 0.4 });
        await assert.rejects(fetchArtefact(repo, a.id, { reason: 'over budget', device }), /daily budget[\s\S]*would have cost/);
        setBudgets(repo, { deviceDayMB: 2048, sessionMB: 0.1 });
        await assert.rejects(fetchArtefact(repo, a.id, { reason: 'over session budget', device }), /session's budget/);
    } finally {
        server.close();
    }
});
