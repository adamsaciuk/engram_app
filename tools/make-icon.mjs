#!/usr/bin/env node
// Generates assets/engram.ico (the tray icon) and assets/states/<state>.png,
// one per tray state: a dark rounded tile with the echo mark, one bright
// point and two rings rippling out from it. Pure Node, no dependencies:
// paints RGBA (4x supersampled) and packs a 32bpp ICO and PNGs.
// Re-run after design changes: node tools/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;

const TILE = [17, 20, 28];       // near-black
const BORDER = [230, 233, 239, 0.12 * 255];
const TEAL = [45, 212, 191];
const AMBER = [242, 165, 65];
const RED = [239, 90, 90];
const GREY = [138, 147, 166];

// Seven tray states (design brief section 5), each a variant of the mark.
const STATES = {
    idle: { accent: TEAL, rings: 2, badge: null },
    listening: { accent: TEAL, rings: 3, badge: null },
    unsynced: { accent: TEAL, rings: 2, badge: AMBER },
    syncing: { accent: TEAL, rings: 1, badge: TEAL },
    locked: { accent: GREY, rings: 0, badge: GREY },
    attention: { accent: AMBER, rings: 2, badge: AMBER },
    error: { accent: RED, rings: 0, badge: RED },
};

const CX = 0.5;
const CY = 0.52;
const POINT_R = 0.085;
const RINGS = [[0.2, 0.05], [0.33, 0.045], [0.44, 0.035]]; // [radius, half-width]

function inRoundRect(u, v, x0, y0, x1, y1, r) {
    if (u < x0 || u > x1 || v < y0 || v > y1) return false;
    const dx = Math.max(x0 + r - u, u - (x1 - r), 0);
    const dy = Math.max(y0 + r - v, v - (y1 - r), 0);
    return dx * dx + dy * dy <= r * r;
}

function over(base, [cr, cg, cb, caA]) {
    const ca = caA / 255;
    return [base[0] * (1 - ca) + cr * ca, base[1] * (1 - ca) + cg * ca, base[2] * (1 - ca) + cb * ca];
}

function shade(u, v, state) {
    const t0 = 0.03;
    const t1 = 0.97;
    if (!inRoundRect(u, v, t0, t0, t1, t1, 0.21)) return [0, 0, 0, 0];
    let base = [...TILE];
    if (!inRoundRect(u, v, t0 + 0.05, t0 + 0.05, t1 - 0.05, t1 - 0.05, 0.16)) base = over(base, BORDER);
    const d = Math.hypot(u - CX, v - CY);
    const A = state.accent;
    if (d <= POINT_R) base = over(base, [...A, 255]);
    else {
        // rings fade at the top-left so the echo reads as travelling
        const angle = Math.atan2(v - CY, u - CX);
        const fade = 0.55 + 0.45 * Math.cos(angle - Math.PI / 4);
        RINGS.slice(0, state.rings).forEach(([r, w], i) => {
            if (Math.abs(d - r) <= w) base = over(base, [...A, [0.72, 0.38, 0.2][i] * 255 * fade]);
        });
    }
    if (state.badge) {
        const bd = Math.hypot(u - 0.8, v - 0.2);
        if (bd <= 0.14) base = over(base, [...state.badge, 255]);
    }
    return [...base, 255];
}

function render(size, state) {
    const px = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let R = 0, G = 0, B = 0, A = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const [r, g, b, a] = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, state);
                    const w = a / 255;
                    R += r * w; G += g * w; B += b * w; A += a;
                }
            }
            const alpha = A / (SS * SS);
            const i = (y * size + x) * 4;
            if (alpha > 0) {
                const wsum = A / 255;
                px[i] = Math.round(R / wsum); px[i + 1] = Math.round(G / wsum); px[i + 2] = Math.round(B / wsum); px[i + 3] = Math.round(alpha);
            }
        }
    }
    return px;
}

function bmpEntry(size, rgba) {
    const andRow = ((size + 31) >> 5) * 4;
    const xorSize = size * size * 4;
    const buf = Buffer.alloc(40 + xorSize + andRow * size);
    buf.writeUInt32LE(40, 0); buf.writeInt32LE(size, 4); buf.writeInt32LE(size * 2, 8);
    buf.writeUInt16LE(1, 12); buf.writeUInt16LE(32, 14); buf.writeUInt32LE(0, 16); buf.writeUInt32LE(xorSize + andRow * size, 20);
    let o = 40;
    for (let y = size - 1; y >= 0; y--) {
        for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            buf[o++] = rgba[i + 2]; buf[o++] = rgba[i + 1]; buf[o++] = rgba[i]; buf[o++] = rgba[i + 3];
        }
    }
    return buf;
}

function writeIco(state, out) {
    const entries = SIZES.map((s) => ({ size: s, data: bmpEntry(s, render(s, state)) }));
    const header = Buffer.alloc(6 + entries.length * 16);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
    let offset = header.length;
    entries.forEach((e, i) => {
        const d = 6 + i * 16;
        header.writeUInt8(e.size >= 256 ? 0 : e.size, d); header.writeUInt8(e.size >= 256 ? 0 : e.size, d + 1);
        header.writeUInt8(0, d + 2); header.writeUInt8(0, d + 3); header.writeUInt16LE(1, d + 4); header.writeUInt16LE(32, d + 6);
        header.writeUInt32LE(e.data.length, d + 8); header.writeUInt32LE(offset, d + 12);
        offset += e.data.length;
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ico = Buffer.concat([header, ...entries.map((e) => e.data)]);
    fs.writeFileSync(out, ico);
    console.log(`wrote ${out} (${SIZES.join('/')}px, ${ico.length} bytes)`);
}

function png(size, state) {
    const rgba = render(size, state);
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
    const table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, cb]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

writeIco(STATES.idle, path.join(ROOT, 'assets', 'engram.ico'));
fs.writeFileSync(path.join(ROOT, 'assets', 'engram.png'), png(256, STATES.idle));
fs.mkdirSync(path.join(ROOT, 'assets', 'states'), { recursive: true });
for (const [name, state] of Object.entries(STATES)) {
    fs.writeFileSync(path.join(ROOT, 'assets', 'states', `${name}.png`), png(32, state));
    fs.writeFileSync(path.join(ROOT, 'assets', 'states', `${name}@16.png`), png(16, state));
}
console.log(`wrote ${Object.keys(STATES).length} state icons in assets/states/`);
