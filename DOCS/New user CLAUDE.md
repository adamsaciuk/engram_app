# Working with Engram

## What Engram is

Engram is the memory an AI keeps for one person. It is a folder on this
computer holding one markdown note per memory (an engram), arranged in a
folder tree called the Cortex, where every folder is a container with a
map note at its top. Each engram opens with an Echo, the few lines a
future session needs in order to pick up where this one left off. It
exists so that nothing the person tells you, decides with you, or gets
from you is lost when the session ends, and so that the next session
starts from what is already known instead of asking again.

The `engram` command is on the path. A tray app keeps a local server
running at http://127.0.0.1:5187 with a page where the person watches
memories arrive, searches them, and manages setup. You write to the
memory through the command only. The person edits from the page. You
never edit a note by hand.

## Session start

Read the memory before you touch anything. Do this in order.

1. Run `engram wake --task "<the task in the person's plain words>"`.
   It prints the root map and a session id. Carry that id on every
   later command as `--session <id>`.
2. If the task belongs to a project the memory already knows, run
   `engram brief <container>`. It hands over that region whole, with
   its rulings in force, its recent Echos and its open gaps.
3. Run `engram recall "<the task>" --session <id>`. It scores every
   Echo, weights the regions the task names, follows links one hop,
   puts decisions in force first, and stops at a token budget. If it
   says more matched than fitted, run it again with a larger
   `--attention N` or a narrower task.
4. Work from what came back. Decisions in force govern the work. Cite
   the Echos you rely on when you write.
5. Ask the person only what the memory cannot answer. If recall has the
   answer, do not ask the question.

Recall again whenever the subject changes mid-session.

## Capture as you go

Every task, idea, bug, request or ruling the person mentions is written
into the memory at the moment it happens. Nothing is batched into a
summary at the end and nothing is skipped as too small. The record grows
as the work happens and is never reconstructed afterwards.

### What counts as an engram

One engram per completed action. When you finish a piece of work, write
it. When the person tells you something worth knowing later, write it as
a learning. When you discover something in the course of the work that
changes how it should be done, write it. If the person raises three
things in one message, that is three engrams, written as each is dealt
with, each with its own verbatim stimulus.

    engram engram --session <id> --container <path> --name "<two to five words>" --stimulus "<what the person said, verbatim>" --done "<what was done>" --echo "<what a future session needs>" [--kind action|learning] [--cites <id>] [--tag <t>]

### Decisions

When the person rules on something, write it with `decide`. A ruling is
one sentence. If it replaces an earlier ruling, link the old one with
`--supersedes`.

    engram decide --session <id> --container <path> --name "<two to five words>" --stimulus "<verbatim>" --decision "<the ruling in one sentence>" --echo "<what a future session needs>" [--supersedes <id>]

### Files

The moment a file exists, log it against the engram that produced it.
The memory records that the file exists and where. The bytes never
enter the memory.

    engram log <file> --engram <id> --session <id>

### The stimulus

The stimulus is the person's words, verbatim. Copy them as typed,
including typos and half sentences. Never paraphrase, never tidy, never
summarise. If the stimulus came from you rather than the person (a
learning you found while working), say so in the stimulus.

### The Echo

The Echo is compulsory. An engram without one has not been written. It
holds what a future session needs in the fewest lines that work: what
was asked, what is now true, and what to watch for. Write it for a
reader who has none of this session's context.

### Naming

The name is two to five words that say what the memory is about, as a
noun phrase. "Login timeout raised" is a name. "We fixed the login
timeout that was causing problems" is a sentence and is not.

### Placing it in the Cortex

Name the container the memory belongs to. When recall suggests a
container, prefer it unless you know better. If none fits, open one
under the nearest that does with
`engram cortex open <parent>/<name> --title "..."`, and see what exists
with `engram cortex list`. Open a container when a project, a client, a
tool or a subject has arrived that will collect more than a few
engrams. Do not open one for a single memory.

After working in a container long enough to know it properly, refresh
its digest so the map at its top is current:

    engram digest <path> --digest "<what this region holds>" --answers "<question it answers>|<another>" --gaps "<what is missing>|<another>"

### Links

Link what you used. `--cites <id>` for every Echo you relied on.
`--supersedes <id>` when a decision replaces an earlier one.
`--refines <id>` when you add detail to an earlier memory.
`--confirms <id>` when the work bears an earlier memory out.
`--contradicts <id>` when two rulings or two facts cannot both stand.

## What never to do

- Never announce a write. Do not say you are about to write, and do not
  say you have written. Write as a rule, without comment. The person
  trusts the rule. The one exception is the single line after rest.
- Never edit or delete an engram. If one is wrong or out of date, write
  a new one that says so and links the old one. Only the person edits
  the memory, from the page.
- Never resolve a contradiction by picking a side. A contradiction is
  two of the person's rulings that cannot both stand, or two recorded
  facts that cannot both be true. A fact and a ruling never contradict:
  the ruling governs and the fact stays cited. Flag it with
  `--contradicts` and leave the ruling to the person.
- Never bank a file on your own judgement. Bytes never enter the memory.
  You may recommend keeping a file; the person alone decides.
- Never engram credentials, keys, tokens or passwords, and nothing the
  person said must not be kept. Record that a value was withheld, never
  the value.
- Never paraphrase a stimulus and never skip the Echo.
- Never leave a session without resting it.

## Session end

Run `engram rest --session <id>`. It closes the session. Then write one
line in chat with the counts: how many engrams, decisions and files were
written. Nothing more. If you are unsure of the memory's health at any
point, `engram status` and `engram check` tell you.

## A worked example

The person says: "the export button on the reports page does nothing
when the date range is empty, can you fix that". A session might run
like this.

    engram wake --task "fix the reports export button when the date range is empty"

Wake prints the root map and the session id `s-0mg1h7k2p-4c9e2a17`.
The map shows a container `projects/reporting`, so the region is known.

    engram brief projects/reporting
    engram recall "reports page export button does nothing with an empty date range" --session s-0mg1h7k2p-4c9e2a17

Recall returns an Echo `0mfx2r8ta-71b0d4e9` saying the export handler
was rewritten last month and validation now lives in the form layer, and
a decision in force that empty ranges default to the last thirty days.
You fix the button so an empty range takes that default, then write the
engram at the moment the fix is in.

    engram engram --session s-0mg1h7k2p-4c9e2a17 --container projects/reporting --name "Export empty range default" --stimulus "the export button on the reports page does nothing when the date range is empty, can you fix that" --done "Empty date range on the reports export now falls back to the last thirty days before the handler runs, matching the ruling in force. Fixed in the form layer validation." --echo "Asked to fix a dead export button on an empty date range. Now true: empty range defaults to thirty days in the form layer. Watch: the same default is not yet applied to the scheduled export." --cites 0mfx2r8ta-71b0d4e9

While testing, the person adds: "actually make it the current month,
not thirty days". That is a new ruling and it replaces the old one.

    engram decide --session s-0mg1h7k2p-4c9e2a17 --container projects/reporting --name "Empty range means current month" --stimulus "actually make it the current month, not thirty days" --decision "An empty date range on any report export defaults to the current calendar month." --echo "Ruling: empty range means current month, replacing the thirty day default. Applies to every report export, scheduled ones included." --supersedes 0mfw9d3ab-2e6f8c40

You change the default and the person confirms it works. That is a
second completed action, so it gets its own engram, linked to the first.

    engram engram --session s-0mg1h7k2p-4c9e2a17 --container projects/reporting --name "Export default now current month" --stimulus "actually make it the current month, not thirty days" --done "Form layer default changed from thirty days to the current calendar month. Person confirmed the button works." --echo "Empty range on the reports export now defaults to the current month. The scheduled export still needs the same default." --refines 0mg1h8c4z-5d1a7b93

The session ends.

    engram rest --session s-0mg1h7k2p-4c9e2a17

Then one line in chat: 2 engrams, 1 decision, 0 files.
