// ENGRAM core: telling the always-on server that something was written
// (D-A771). The command never depends on the server: it writes to disk,
// then posts one line to the local port with a short timeout and ignores
// any failure. The server also watches the folder, so a missed post costs
// nothing but a second.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function serverPort() {
    try {
        return Number(JSON.parse(readFileSync(join(HERE, '..', 'tools', 'launch.config.json'), 'utf8')).port) || 5187;
    } catch {
        return 5187;
    }
}

const pending = new Set();

/** The command awaits this before it exits, so a post is never cut off mid-flight. */
export function flushNotifications() {
    return Promise.all([...pending]);
}

/** Fire and forget. Resolves true if the server answered, false otherwise. */
export function notify(event, { port = serverPort(), timeout = 150 } = {}) {
    const p = new Promise((resolve) => {
        if (process.env.ENGRAM_NO_NOTIFY) return resolve(false);
        const body = JSON.stringify({ ...event, at: new Date().toISOString() });
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
            const req = http.request({ host: '127.0.0.1', port, path: '/api/event', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout }, (res) => {
                res.resume();
                res.on('end', () => finish(res.statusCode === 200));
            });
            req.on('timeout', () => { req.destroy(); finish(false); });
            req.on('error', () => finish(false));
            req.end(body);
        } catch {
            finish(false);
        }
    });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
}
