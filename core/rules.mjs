// ENGRAM core: the rules. The standing instructions a session loads before
// it reads the request. Written into every memory as ENGRAM.md at setup
// and installed into the user's CLAUDE.md as a versioned block, so every
// session that can run the command is bound by them (D-A764).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BT = String.fromCharCode(96);

export const RULES_VERSION = 6;

export const RULES_MD = `# ENGRAM RULES, version ${RULES_VERSION}

Engram is the memory an AI keeps for one person: every session's work,
indexed so the next session finds it. This session reads it before
acting, writes to it as it works, and closes it before it ends. These
rules are not advice. Follow them on every action, in this order.

## 1. Wake

Run \`engram wake --task "<the task in plain words>"\` before anything
else. It prints the root map and a session id. Carry that id on every
later command as \`--session <id>\`. When the task belongs to a project
the memory already knows, run \`engram brief <container>\` next: it hands
over that region whole, its rulings in force, its recent Echos and its
open gaps, at a fixed cost.

## 2. Recall

Run \`engram recall "<the task in plain words>" --session <id>\`. It
searches every Echo, weights the regions the task names, follows links
one hop, puts the decisions in force first, and stops at the token
budget. Work from what it returns. If it says more matched than fitted,
ask again with a larger \`--attention\` or a narrower task. Recall again
whenever the subject changes.

## 3. Engram as you act

Every completed action writes one engram, at the moment it completes,
with its Echo:

    engram engram --session <id> --container <path> --name "<two to five words>" --stimulus "<the request verbatim>" --done "<what was done>" --echo "<what a future session needs: what was asked, what is now true, what to watch for>"

A ruling is written as a decision:

    engram decide --session <id> --container <path> --name "<two to five words>" --stimulus "..." --decision "<the ruling in one sentence>" --echo "..." [--supersedes <id>]

A file produced is logged the moment it exists:

    engram log <path> --engram <id> --session <id>

The name is what the engram is called in the memory: two to five words
that say what the memory is about (a noun phrase, not a sentence). The
stimulus is the person's words, verbatim, never paraphrased. The Echo
is compulsory: an engram without one has not been written. Link what
you used: \`--cites <id>\` for every Echo you relied on, \`--supersedes <id>\`
when a decision replaces an earlier one, \`--refines\`, \`--confirms\`,
\`--contradicts\` as they apply.

## 4. Write silently

Never tell the person you are about to write, or that you have written.
Never spend their tokens on the memory's administration. Write as a rule,
without comment; the person trusts the rule, not the announcement. The
one exception is rest (rule 9), one line.

## 5. Never edit, never delete

To the AI an engram is immutable. If it is wrong or outdated, write a new
one that says so and links the old one. Only the person edits their
memory, from the page.

A contradiction is two of the person's rulings that cannot both stand, or
two recorded facts that cannot both be true. A fact and a ruling never
contradict: the person's ruling governs, and the fact stays cited. Never
resolve a contradiction by choosing a side: flag it with
\`--contradicts\` and leave the ruling to the person.

## 6. Place it in the Cortex

Name the container the memory belongs to. If none fits, open one under
the nearest that does: \`engram cortex open <parent>/<name> --title "..."\`.
When recall suggests a container, prefer it unless you know better. After
writing into a container, refresh its digest when you have read it
properly: \`engram digest <path> --digest "..." --answers "a|b" --gaps "..."\`.

## 7. Bank nothing on your own judgement

Bytes never enter the memory. Long-term storage takes a file only on the
person's explicit word. You may recommend banking; never bank.

## 8. Never engram what must not persist

No credentials, keys, tokens, passwords, and nothing the person said must
not be kept. Record that a value was withheld, never the value.

## 9. Rest

At the end of the session run \`engram rest --session <id>\`. It closes
the session. Then one line: how many engrams, decisions and artefacts
were written. Nothing more.
`;

export const CLAUDE_MD = `# This folder is an Engram memory

Read \`ENGRAM.md\` first and follow it. Then run \`engram wake\`. Never
edit or delete an engram; the map notes are rebuilt by the tool and are
not hand-edited.
`;
// --------------------------------------------- the block in CLAUDE.md ---

const OPEN = (v) => `<!-- engram:rules ${v} -->`;
const CLOSE = '<!-- /engram:rules -->';
const BLOCK_RE = /<!-- engram:rules (\d+) -->[\s\S]*?<!-- \/engram:rules -->\n?/;

/**
 * The instruction installed into the user's CLAUDE.md (D-A764, D-A979):
 * the whole way of working with Engram, so a session on this computer
 * needs nothing else. The text is DOCS/New user CLAUDE.md, shipped with
 * the application; the version marker lets a newer Engram refresh it.
 */
export const INSTRUCTION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'DOCS', 'New user CLAUDE.md');

export function instructionText() {
    try { return readFileSync(INSTRUCTION_PATH, 'utf8').split('\r\n').join('\n').trim(); } catch { return ''; }
}

export function claudeBlock(version = RULES_VERSION) {
    const fallback = [
        `# ENGRAM (compulsory, rules version ${version})`,
        '',
        'Every session that can run the ' + BT + 'engram' + BT + ' command is bound by the memory\'s',
        'rules: wake, recall, engram as you act (silently), rest. The full rules',
        'are printed by wake and live in the memory as ' + BT + 'ENGRAM.md' + BT + '.',
    ].join('\n');
    return `${OPEN(version)}\n${instructionText() || fallback}\n${CLOSE}\n`;
}

export function installedRulesVersion(claudeMdPath) {
    try {
        const m = readFileSync(claudeMdPath, 'utf8').match(/<!-- engram:rules (\d+) -->/);
        return m ? Number(m[1]) : 0;
    } catch {
        return 0;
    }
}

/** Install or refresh the block; returns { path, action, version }. */
export function installClaudeBlock(claudeMdPath, version = RULES_VERSION) {
    const block = claudeBlock(version);
    let text = '';
    try { text = readFileSync(claudeMdPath, 'utf8'); } catch { text = ''; }
    const had = BLOCK_RE.test(text);
    const current = installedRulesVersion(claudeMdPath);
    if (had && current === version) return { path: claudeMdPath, action: 'unchanged', version };
    const next = had ? text.replace(BLOCK_RE, block) : (text.trimEnd() ? text.trimEnd() + '\n\n' + block : block);
    mkdirSync(dirname(claudeMdPath), { recursive: true });
    writeFileSync(claudeMdPath, next, 'utf8');
    return { path: claudeMdPath, action: had ? 'updated' : 'installed', version };
}

export function removeClaudeBlock(claudeMdPath) {
    if (!existsSync(claudeMdPath)) return false;
    const text = readFileSync(claudeMdPath, 'utf8');
    if (!BLOCK_RE.test(text)) return false;
    writeFileSync(claudeMdPath, text.replace(BLOCK_RE, '').trimEnd() + '\n', 'utf8');
    return true;
}

// ------------------------------------------------------------- the brief ---

/** The brief printed by "engram wake": the rules, the session, the root map. */
export function brief(rules, rootMap, device, session, stats) {
    const lines = [];
    lines.push(rules.trimEnd());
    lines.push('');
    lines.push('# WAKE');
    lines.push('');
    lines.push(`Session: ${session.id}`);
    lines.push(`Task: ${session.task || '(none stated)'}`);
    lines.push(`Device: ${device.name} (${device.id}). Memory: ${stats.containers} containers, ${stats.engrams} engrams, ${stats.decisions} decisions, ${stats.artefacts} artefacts, ${stats.devices} devices.`);
    lines.push('');
    lines.push('## Root map');
    lines.push('');
    lines.push(renderMap(rootMap));
    return lines.join('\n') + '\n';
}

/** A container map as compact markdown for a bundle or the brief. */
export function renderMap(m) {
    const out = [];
    out.push(`### ${m.path || 'root'}${m.title && m.title !== (m.path || 'root').split('/').pop() ? ' (' + m.title + ')' : ''}`);
    if (m.digest) out.push(m.digest.trim());
    else out.push('(no digest yet: write one with "engram digest" once you have read this region)');
    if (m.answers && m.answers.length) out.push('Answers: ' + m.answers.join(' | '));
    if (m.decisions && m.decisions.length) out.push(`Decisions in force: ${m.decisions.length}${m.superseded && m.superseded.length ? ' (' + m.superseded.length + ' superseded in history)' : ''}`);
    if (m.contradictions && m.contradictions.length) out.push(`Contradictions flagged: ${m.contradictions.length}`);
    if (m.children && m.children.length) {
        out.push('Children:');
        for (const c of m.children) out.push(`- ${c.path}: ${c.line}`);
    }
    if (m.hubs && m.hubs.length) {
        out.push('Hubs:');
        for (const e of m.hubs) out.push(`- ${e.id}: ${e.line}`);
    }
    if (m.recent && m.recent.length) {
        out.push('Recent:');
        for (const r of m.recent) out.push(`- ${r.when.slice(0, 10)} ${r.id}: ${r.line}`);
    }
    if (m.linksOut && m.linksOut.length) out.push('Strongest links out: ' + m.linksOut.map((h) => `${h.path || 'root'} (${h.count})`).join(', '));
    if (m.gaps && m.gaps.length) out.push('Known gaps: ' + m.gaps.join(' | '));
    if (m.vocabulary && m.vocabulary.length) out.push('Vocabulary: ' + m.vocabulary.slice(0, 12).map((v) => v[2] || v[0]).join(', '));
    out.push(`Engrams: ${m.counts.engrams} here, ${m.counts.descendants} beneath.`);
    return out.join('\n');
}
