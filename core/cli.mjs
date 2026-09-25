#!/usr/bin/env node
// ENGRAM: the command. Zero dependencies. Every verb the rules mention is
// here, and this is what the MCP relay will expose as tools later (D-A781).
//
//   engram setup <dir> [--title "..."] [--no-rules]   create a memory in that folder (or adopt one), select it,
//                                              install the rules, put the command on the path
//   engram use <dir>                           select an existing memory
//   engram forget                              start fresh: no memory selected (the folder stays)
//   engram wake [--task "..."]                 print the rules, the root map, and a session id
//   engram brief <container> [--attention N]   one region whole: map, rulings in force, recent Echos, gaps
//   engram recall "<task>" [--attention N] [--all] [--json] [--session id]
//   engram search "<words>" [--json]           the index a person searches: regions named, every Echo scored
//   engram engram --container p --name "<2-5 words>" --stimulus "..." --echo "..." [--done ..] [--kind k]
//                 [--cites id]... [--supersedes id]... [--refines id]... [--confirms id]... [--contradicts id]...
//                 [--tag t]... [--open --title ..] [--session id]
//   engram decide --container p --name "<2-5 words>" --stimulus "..." --decision "..." --echo "..." [--supersedes id] [--session id]
//   engram log <file> --engram <id> [--note ..] [--session id]
//   engram recommend <artefactId> --reason "..."
//   engram digest <path> [--digest ..] [--answers "a|b"] [--gaps "a|b"] [--title ..]
//   engram cortex open <path> [--title ..] | move <from> <toParent|/> | list
//   engram sessions                             every session this memory has seen
//   engram sleep                                the scheduled pass (mechanical)
//   engram rest [--session id]                  close the session
//   engram rules [--install|--remove] [--file path]   the rules block in CLAUDE.md
//   engram compact [<container>] [--all] [--auto] | --name ".." --echo "..." --covers a,b,c | key --file f
//                                              compacting: many small Echos become one consolidation that stands for them
//   engram storage set --endpoint url --bucket b [--region r] [--prefix p] | key --file <pack.json> | status
//   engram bank <artefactId> --by-user           the person banks bytes to long-term storage (never the AI)
//   engram fetch <artefactId> --reason "..."     a budgeted, reasoned, recorded download into the cache
//   engram check [--json]                      the setup checklist: fully installed when every line is ok
//   engram shim                                put the engram command on the path
//   engram status
//   engram serve <--launch|--serve|--status|--stop>   the local server
//   --repo <dir> on any command selects a memory for that call only.

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Repository, resolveRepoPath, writeConfig, thisDevice, readConfig } from './repository.mjs';
import { engram, decide, logArtefact, recommendBank, digest, openContainer, moveContainer, sleep } from './engram.mjs';
import { recall } from './recall.mjs';
import { search, brief as regionBrief } from './search.mjs';
import { brief, renderMap, installClaudeBlock, removeClaudeBlock, installedRulesVersion, RULES_VERSION } from './rules.mjs';
import { readMaps } from './index.mjs';
import { openSession, resolveSession, restSession } from './session.mjs';
import { claudeMdPath as claudeMdAt } from './cli-paths.mjs';
import { flushNotifications } from './notify.mjs';
import { candidates, proposals as compactProposals, brief as compactBrief, consolidate, writeWithClaude, storeApiKey, COMPACT_MIN, COMPACT_AGE_DAYS } from './compact.mjs';
import { setStorage, storageOf, storeCredentials, readCredentialFile, hasCredentials, bank, fetchArtefact, budgetsOf, usage, cacheDir } from './storage.mjs';
import { setupMemory, writeShim, addShimToPath, shimDir, check as setupCheck, renderCheck } from './setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOL = new Set(['open', 'no-trace', 'json', 'help', 'all', 'install', 'remove', 'no-rules', 'by-user', 'auto']);

function parse(argv) {
    const flags = {};
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            let val = true;
            if (!BOOL.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
            if (flags[key] === undefined) flags[key] = val;
            else flags[key] = [].concat(flags[key], val);
        } else if (a === '-m' && i + 1 < argv.length) {
            flags.message = argv[++i];
        } else pos.push(a);
    }
    return { flags, pos };
}

const list = (v) => (v === undefined ? [] : [].concat(v));
const split = (v) => (v === undefined ? undefined : String(v).split('|').map((s) => s.trim()).filter(Boolean));

function repoFrom(flags) {
    const repo = new Repository(resolveRepoPath(flags.repo));
    if (!repo.exists()) throw new Error(`no memory at ${repo.root}. Open Setup and pick a folder, or run "engram setup ${repo.root}".`);
    return repo;
}

function rulesOf(repo) {
    try { return readFileSync(join(repo.root, 'ENGRAM.md'), 'utf8'); } catch { return ''; }
}

function claudeMdPath(flags = {}) {
    return claudeMdAt(flags.file);
}

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 36).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

async function main(argv) {
    const { flags, pos } = parse(argv);
    const cmd = pos[0];
    if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return 0; }

    switch (cmd) {
        case 'setup': {
            const dir = pos[1] || readConfig().repository;
            if (!dir) throw new Error('usage: engram setup <dir> [--title "..."]');
            const r = setupMemory(dir, { title: flags.title });
            const out = [`${r.fresh ? 'created' : 'adopted'} memory at ${r.repository}; device ${r.device.name} (${r.device.id}); selected.`];
            out.push(`rules: ${r.rules.action} version ${r.rules.version} in ${r.rules.path}`);
            out.push(`command: ${r.shim}; ${r.path === 'added' ? 'folder added to the user path (open a new shell)' : r.path === 'present' ? 'folder already on the path' : 'add ' + shimDir() + ' to the path by hand'}`);
            out.push('Next: "engram wake --task ..." in every session.');
            console.log(out.join('\n'));
            return 0;
        }
        case 'use': {
            const dir = pos[1];
            if (!dir) throw new Error('usage: engram use <dir>');
            const repo = new Repository(resolve(dir));
            if (!repo.exists()) throw new Error(`no memory at ${repo.root}`);
            writeConfig({ repository: repo.root });
            console.log(`active memory: ${repo.root}`);
            return 0;
        }
        case 'forget': {
            // start fresh: the selection is cleared, the folder stays
            const had = readConfig().repository || null;
            writeConfig({ repository: null });
            console.log(had ? `forgotten: ${had} is no longer selected (untouched on disk). Open Setup or run "engram setup <folder>".` : 'no memory was selected.');
            return 0;
        }
        case 'wake': {
            const repo = repoFrom(flags);
            const device = thisDevice();
            repo.writeDevice(device);
            const session = openSession(repo, device, { task: flags.task ? String(flags.task) : '' });
            const { maps } = readMaps(repo, repo.allEngrams());
            process.stdout.write(brief(rulesOf(repo), maps.get(''), device, session, repo.stats()));
            return 0;
        }
        case 'brief': {
            const repo = repoFrom(flags);
            if (pos[1] === undefined) throw new Error('usage: engram brief <container> [--attention N]');
            const r = regionBrief(repo, pos[1] === '/' ? '' : pos[1], { attention: flags.attention ? Number(flags.attention) : undefined });
            if (flags.json) console.log(JSON.stringify(r, null, 2));
            else process.stdout.write(r.bundle);
            return 0;
        }
        case 'recall': {
            const repo = repoFrom(flags);
            const task = pos.slice(1).join(' ');
            if (!task) throw new Error('usage: engram recall "<task>" [--attention N] [--all]');
            const r = recall(repo, task, { attention: flags.attention ? Number(flags.attention) : undefined, write: !flags['no-trace'], rules: flags.rules ? rulesOf(repo) : undefined, mode: flags.all ? 'all' : 'ai', sessionId: flags.session });
            if (flags.json) console.log(JSON.stringify({ entered: r.entered, handed: r.handed, decisions: r.decisions, history: r.history, contradictions: r.contradictions, gaps: r.gaps, echos: r.echos, linked: r.linked, excluded: r.excluded, suggest: r.suggest, used: r.used, route: r.route, cost: r.cost }, null, 2));
            else process.stdout.write(r.bundle);
            return 0;
        }
        case 'search': {
            const repo = repoFrom(flags);
            const q = pos.slice(1).join(' ');
            if (!q) throw new Error('usage: engram search "<words>"');
            const r = search(repo, q);
            if (flags.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
            if (r.regions.length) { console.log('Regions:'); for (const x of r.regions) console.log(`  ${x.path || '(root)'}  ${x.title}  ${x.engrams} engrams${x.decisions ? ', ' + x.decisions + ' rulings' : ''}${x.byName ? '  (named)' : ''}`); }
            if (r.decisions.length) { console.log('Rulings in force:'); for (const d of r.decisions) console.log(`  - ${d.text}  (${d.container || 'root'}, ${d.when.slice(0, 10)})`); }
            console.log(`Echos (${r.total}):`);
            for (const e of r.echos) console.log(`  ${e.when.slice(0, 10)} [${e.kind}] ${e.title}  ${e.container}  ${e.id}${e.superseded ? '  (superseded)' : ''}`);
            console.log(`${r.total} matched in ${r.ms} ms.`);
            return 0;
        }
        case 'engram':
        case 'decide': {
            const repo = repoFrom(flags);
            const fields = {
                container: flags.container,
                stimulus: flags.stimulus,
                done: flags.done,
                echo: flags.echo,
                decision: flags.decision,
                kind: flags.kind,
                cites: flags.cites ? [].concat(flags.cites).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean) : [],
                supersedes: list(flags.supersedes),
                refines: list(flags.refines),
                confirms: list(flags.confirms),
                contradicts: list(flags.contradicts),
                produced_from: list(flags['produced-from']),
                tags: list(flags.tag),
                open: !!flags.open,
                title: flags.title,
                name: flags.name,
                session: flags.session,
            };
            if (fields.container === undefined) throw new Error('--container <path> is required (recall suggests one)');
            const e = cmd === 'decide' ? decide(repo, fields) : engram(repo, fields);
            console.log(`engrammed ${e.id} (${e.kind}) in ${e.container || 'root'}, session ${e.session}`);
            return 0;
        }
        case 'log': {
            const repo = repoFrom(flags);
            const file = pos[1];
            if (!file || !flags.engram) throw new Error('usage: engram log <file> --engram <id> [--note "..."]');
            const a = logArtefact(repo, { engram: flags.engram, path: file, note: flags.note, session: flags.session });
            console.log(`logged ${a.name} as ${a.id} (${a.size} bytes, ${a.availability} on ${a.device})`);
            return 0;
        }
        case 'recommend': {
            const repo = repoFrom(flags);
            if (!pos[1]) throw new Error('usage: engram recommend <artefactId> --reason "..."');
            const e = recommendBank(repo, { artefact: pos[1], reason: flags.reason, container: flags.container, session: flags.session });
            console.log(`recommendation written as ${e.id}. Nothing moved; the person decides.`);
            return 0;
        }
        case 'digest': {
            const repo = repoFrom(flags);
            const path = pos[1] === undefined || pos[1] === '/' ? '' : pos[1];
            const e = digest(repo, path, { digest: flags.digest, answers: split(flags.answers), gaps: split(flags.gaps), title: flags.title, session: flags.session });
            const { maps } = readMaps(repo, repo.allEngrams());
            console.log(renderMap(maps.get(path.replace(/^\/+|\/+$/g, ''))));
            if (e) console.log(`digest written as ${e.id}`);
            return 0;
        }
        case 'cortex': {
            const repo = repoFrom(flags);
            const sub = pos[1];
            if (sub === 'open') {
                if (!pos[2]) throw new Error('usage: engram cortex open <path> [--title "..."]');
                const p = openContainer(repo, pos[2], flags.title);
                console.log(`container ${p} ready (${repo.readTitle(p)})`);
            } else if (sub === 'move') {
                if (!pos[2]) throw new Error('usage: engram cortex move <from> <toParent|/>');
                const dest = moveContainer(repo, pos[2], pos[3] === '/' ? '' : pos[3] || '');
                console.log(`moved to ${dest}`);
            } else if (sub === 'list' || !sub) {
                const { maps } = readMaps(repo, repo.allEngrams());
                for (const c of repo.listContainers()) {
                    const m = maps.get(c);
                    console.log(`${c || '(root)'}  ${m.counts.engrams} engrams, ${m.counts.descendants} beneath, ${m.decisions.length} decisions${m.contradictions.length ? ', ' + m.contradictions.length + ' contradiction(s) flagged' : ''}${m.digest ? '  ' + m.digest.slice(0, 80) : ''}`);
                }
            } else throw new Error(`unknown cortex verb "${sub}" (open | move | list)`);
            return 0;
        }
        case 'sessions': {
            const repo = repoFrom(flags);
            for (const s of repo.listSessions()) console.log(`${s.id}  ${s.deviceName || s.device}  ${s.started.slice(0, 16)}  ${s.engrams} engrams, ${s.decisions} decisions, ${s.recalls} recalls, ${s.recallTokens + s.engramTokens} tokens${s.rested ? '  rested' : '  open'}  ${s.task || ''}`);
            return 0;
        }
        case 'sleep': {
            const repo = repoFrom(flags);
            const r = sleep(repo);
            console.log(`slept: ${r.rebuilt} maps rebuilt.`);
            for (const p of r.proposals) console.log(`  proposal: ${p}`);
            if (!r.proposals.length) console.log('  no proposals.');
            return 0;
        }
        case 'rest': {
            const repo = repoFrom(flags);
            const device = thisDevice();
            const session = resolveSession(repo, device, flags.session);
            restSession(repo, session);
            const s = repo.readSession(device.id, session.id) || session;
            console.log(`session ${session.id} rested: ${s.engrams || 0} engrams, ${s.decisions || 0} decisions, ${s.artefacts || 0} artefacts, ${s.recalls || 0} recalls.`);
            return 0;
        }
        case 'rules': {
            const path = claudeMdPath(flags);
            if (flags.remove) { console.log(removeClaudeBlock(path) ? `removed the Engram block from ${path}` : `no Engram block in ${path}`); return 0; }
            if (flags.install) { const r = installClaudeBlock(path); console.log(`rules: ${r.action} version ${r.version} in ${r.path}`); return 0; }
            const v = installedRulesVersion(path);
            console.log(`rules version ${RULES_VERSION} in the application; ${v ? 'version ' + v + ' installed' : 'not installed'} in ${path}${v && v !== RULES_VERSION ? ' (run "engram rules --install" to refresh)' : ''}`);
            return 0;
        }
        case 'compact': {
            if (pos[1] === 'key') {
                if (!flags.file) throw new Error('usage: engram compact key --file <file holding the Claude API key>');
                const p = storeApiKey(readFileSync(String(flags.file), 'utf8'));
                console.log(`Claude API key stored for this user on this computer (${p}); never printed, never in the memory.`);
                return 0;
            }
            const repo = repoFrom(flags);
            const path = pos[1] === undefined || pos[1] === '/' ? '' : pos[1];
            if (pos[1] === undefined && !flags.echo) {
                const list = compactProposals(repo);
                if (!list.length) console.log('nothing to compact: no container has ' + COMPACT_MIN + ' or more settled, uncovered Echos.');
                for (const x of list) console.log(`${x.container || '(root)'}: ${x.count} Echos to consolidate. Run: engram compact ${x.container || '/'}`);
                return 0;
            }
            const list = candidates(repo, path, { all: !!flags.all });
            if (flags.echo) {
                const e = consolidate(repo, path, { echo: flags.echo, covers: flags.covers, name: flags.name, session: flags.session });
                console.log(`consolidated ${e.links.length} Echos of ${e.container || 'root'} into ${e.id}. They step back in recall; the consolidation stands for them.`);
                return 0;
            }
            if (!list.length) { console.log(`nothing to compact in ${path || 'root'}: no settled, uncovered Echos${flags.all ? '' : ' older than ' + COMPACT_AGE_DAYS + ' days (use --all to include recent ones)'}.`); return 0; }
            if (flags.auto) {
                const r = await writeWithClaude(repo, path, list);
                const e = consolidate(repo, path, { echo: r.text, covers: list.map((x) => x.id), session: flags.session });
                console.log(`consolidated ${list.length} Echos of ${e.container || 'root'} into ${e.id} (Claude, ${(r.usage.input_tokens || 0) + (r.usage.output_tokens || 0)} tokens).`);
                return 0;
            }
            process.stdout.write(compactBrief(repo, path, list) + '\n');
            return 0;
        }
        case 'storage': {
            const repo = repoFrom(flags);
            const sub = pos[1];
            if (sub === 'set') {
                const st = setStorage(repo, { endpoint: flags.endpoint, bucket: flags.bucket, region: flags.region, prefix: flags.prefix });
                console.log(`long-term storage: ${st.endpoint} bucket ${st.bucket}${st.prefix ? ' prefix ' + st.prefix : ''} (region ${st.region}). Recorded in settings.json; no key in it.`);
                return 0;
            }
            if (sub === 'key') {
                if (!flags.file) throw new Error('usage: engram storage key --file <key vault pack or json with the access key pair>');
                const creds = readCredentialFile(String(flags.file));
                const path = storeCredentials(repo, creds);
                let extra = '';
                if (creds.bucket && creds.endpoint && !storageOf(repo)) { setStorage(repo, creds); extra = ' Endpoint and bucket taken from the file too.'; }
                console.log(`storage key stored for this user on this computer (${path}); the values were not printed and never enter the memory.${extra}`);
                return 0;
            }
            const st = storageOf(repo);
            const device = thisDevice();
            const u = usage(repo, device.id);
            const b = budgetsOf(repo);
            console.log(st ? `storage: ${st.endpoint} bucket ${st.bucket}${st.prefix ? ' prefix ' + st.prefix : ''}; key ${hasCredentials(repo) ? 'present' : 'MISSING'} on this computer; today ${(u.todayBytes / 1e6).toFixed(1)} of ${b.deviceDayMB} MB; per session ${b.sessionMB} MB; cache ${cacheDir(repo)}` : 'no long-term storage configured. "engram storage set --endpoint <url> --bucket <b>" then "engram storage key --file <pack>".');
            return 0;
        }
        case 'bank': {
            const repo = repoFrom(flags);
            if (!pos[1]) throw new Error('usage: engram bank <artefactId> --by-user');
            const a = await bank(repo, pos[1], { byUser: !!flags['by-user'], session: flags.session });
            console.log(`banked ${a.name} (${a.size} bytes) as ${a.objectKey}; availability ${a.availability}.`);
            return 0;
        }
        case 'fetch': {
            const repo = repoFrom(flags);
            if (!pos[1]) throw new Error('usage: engram fetch <artefactId> --reason "..."');
            const r = await fetchArtefact(repo, pos[1], { reason: flags.reason, session: flags.session });
            console.log(r.cached ? `served from the cache: ${r.path}` : `fetched ${r.bytes} bytes (about ${r.cost.toFixed(3)}) to ${r.path}; written to the ledger.`);
            return 0;
        }
        case 'check': {
            const c = await setupCheck();
            console.log(flags.json ? JSON.stringify(c, null, 2) : renderCheck(c));
            return c.ok ? 0 : 1;
        }
        case 'shim': {
            const file = writeShim();
            const r = addShimToPath();
            console.log(`command file ${file}; ${r === 'added' ? 'folder added to the user path (open a new shell)' : r === 'present' ? 'folder already on the path' : 'add ' + shimDir() + ' to the path by hand'}`);
            return r === 'failed' ? 1 : 0;
        }
        case 'status': {
            const cfg = readConfig();
            let repo;
            try { repo = repoFrom(flags); } catch (e) { console.log(e.message); return 1; }
            const st = repo.stats();
            console.log(`Memory: ${repo.root}`);
            console.log(`Device: ${cfg.device ? cfg.device.name + ' (' + cfg.device.id + ')' : '(unregistered)'}`);
            console.log(`Containers: ${st.containers}  Engrams: ${st.engrams}  Decisions: ${st.decisions}  Artefacts: ${st.artefacts}`);
            console.log(`Rules: version ${RULES_VERSION}; ${installedRulesVersion(claudeMdPath(flags)) || 'not'} installed in CLAUDE.md`);
            console.log(`Storage: ${storageOf(repo) ? storageOf(repo).bucket + (hasCredentials(repo) ? '' : ' (no key here)') : 'none'}`);
            return 0;
        }
        case 'serve': {
            const child = spawn(process.execPath, [join(HERE, '..', 'server', 'server.mjs'), ...argv.slice(1)], { stdio: 'inherit', windowsHide: true });
            return await new Promise((r) => child.on('exit', (code) => r(code ?? 0)));
        }
        default:
            throw new Error(`unknown command "${cmd}". Run "engram help".`);
    }
}

main(process.argv.slice(2)).then(async (code) => { await flushNotifications(); process.exit(code); }, (err) => {
    console.error(`engram: ${err.message}`);
    process.exit(1);
});
