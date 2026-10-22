# App memory scope (2026-10-22)

control-6 made the system prompt's memory heading say that the user asking what you
remember, to remember something or to forget something "means this list, not your own
memory files", and control-7's ThreadPrompt sentence sent every "from now on" to
`memory add`, "never your own memory files". That picked the store by the verb. The
verb does not pick a store; the content does. "Remember this repo uses pnpm" is a
project fact; "what do you remember about this codebase?" asks about Claude's own
memory files. Under the old wording both went to the app memory, which is global: one
list, injected into every thread of every project, capped at 40 entries. A project fact
there leaks into unrelated projects and spends the cap. Prompt and skill text only; no
daemon or GUI change.

## The rule

The one axis that separates the stores: does it apply to every thread in every project
(the app memory, per user), or to this user, project or codebase (Claude's own memory
files, per project)?

* **ThreadPrompt** (`internal/store/thread/workspace.go`): "how you should act in every
  project (always, never, keep answers short) goes to code-foundry memory add <their
  words> at once, without asking; what you learn about the user, a project or its code
  goes in your memory files; asked what you remember, give both". "At once, without
  asking" stays: it is what fixed the under-trigger in control-7. To stay under the
  1,400-byte cap the paragraph lost "(the project folder)" after "In place" and "file"
  from "a file path in your reply" (1,399 bytes).
* **MemoryHeading** (`internal/store/thread/memory.go`): the entries "hold in every
  project, so a new one goes here at once; a fact about the user, a project or a
  codebase belongs in your own memory files, not here; asked what you remember, give
  both lists and say which is which".
* **Help skill**, "Remembering preferences" (105 of 105 lines, reflowed): the intro
  names the scope and the pnpm example; "What do you remember?" is `memory show` plus
  the thread's own memory files, each labelled; "forget X" acts on whichever holds X.

## Eval (2026-10-22, isolated home)

`make build`; the daemon with `CODE_FOUNDRY_HOME` in a scratch directory, the branch's
`bin` first on `PATH`, no `CLAUDE*`/`CODE_FOUNDRY_*` variables; a scratch git repo under
`$HOME` as the project; `claude-sonnet-5-5[1m]`, medium (control-7 used Haiku 5.5). The
app memory held "Always open PRs as drafts" first. Fresh threads, one prompt each, plus
one follow-up:

| Prompt | Result |
|---|---|
| from now on keep your answers short | `memory add "keep answers short"` at once; "Got it. I've saved that" |
| remember this repo uses pnpm, not npm | wrote `…/memory/uses-pnpm.md` + MEMORY.md in its own project memory, nothing in the app memory; "saved it as a note for this project" |
| forget the pnpm thing (follow-up in that thread) | `rm` of the note and its index line; the app list untouched |
| what do you remember? | "I remember two sets of things": the Code Foundry preferences (every project) and its memory files (this project, the pnpm line); the run before the pnpm note existed said the second set was empty and explained which store takes what |
| from now on always run make check before you commit | `memory add`, "in every project": the user said "from now on always", so the app memory is the reading the rule gives; a user who meant one project can say so |

The threads, transcripts, scratch repo, home and the project's memory directory were
deleted after.

## Left out

The entry skill's table row and `daemon.capabilities --group memory` still describe
only the app side; they say nothing wrong. No GUI for the memory (control-6).

## Daemon restart

Needed: the system prompt constants and the skill files are compiled into the daemon.
