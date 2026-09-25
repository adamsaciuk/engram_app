# Engram

The memory an AI keeps for one person.

Every session with an AI normally starts empty. With Engram, every session
starts by remembering, works by recording, and ends by closing. The memory
is one folder on your computer that you own: a Cortex of Context
Containers, each a folder with a map at its top; one plain text note per
engram with its Echo first; typed links between Echos in any direction.
Its job is to be an expert indexer: a second session on a project finds
the relevant context fast, with few tokens, and nothing is retaught.

## Setting up

Run the installer. Engram appears in the system tray and starts with
Windows from then on. Open Setup from the tray, pick the folder Engram
writes your memories into, and that is the whole setup: the rules go into
Claude's CLAUDE.md and the `engram` command goes on your path.

Then: click the tray icon to open Engram. Live shows every memory
arriving as sessions work. Search works like a web search: type a project
name and get everything about it. Add or edit a memory yourself from the
page. Close the window like any window; the tray keeps the memory alive.

## The command

```
engram wake --task "the task in plain words"
engram brief <container>                       one project, whole, at a fixed cost
engram recall "the task in plain words" --session <id>
engram search "words"                          the index a person searches
engram engram --session <id> --container <path> --name "<2-5 words>" --stimulus "..." --done "..." --echo "..."
engram decide --session <id> --container <path> --name "<2-5 words>" --stimulus "..." --decision "..." --echo "..."
engram rest --session <id>
engram check                                   the setup checklist
```

## The rules the AI follows

Printed by `engram wake`, installed into CLAUDE.md at setup, and kept in
the memory as `ENGRAM.md`. Wake, brief, recall, engram as you act, write
silently, never edit or delete, place it in the Cortex, bank nothing on
your own judgement, never engram what must not persist, rest.

## For developers

Zero-dependency Node core, plain ESM, no build step. Electron is the
tray's concern only. `npm test` runs the suite; `npm run dist` builds the
installer. The manual is `CLAUDE.md`; the session log is `HANDOVER.md`.
