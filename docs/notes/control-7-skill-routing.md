# Skill routing fixes (2026-10-22)

Testers ran Haiku 5.5 threads against control-1 to control-6. The recurring failure was
routing: on ordinary task-shaped prompts no code-foundry skill loaded and the model
acted like a terminal assistant. It said "run /model" (the app refuses it) and "run
/cost". It built a chart from `~/.claude/projects` instead of `usage.show --json`. It
started an http.server and opened the browser instead of writing an .html file the File
tab renders. It used raw git/gh for a PR. It saved preferences to Claude Code's own
memory. It said every thread gets its own worktree (the default is In place). It refused
"show me the worktree panel" because no window showed the thread. It ran `view.projects`
from an off-screen thread. And it told users skill and command names. Skill text, the
system prompt, capabilities text, the guide and one plugin result; no GUI change.

## ThreadPrompt

The skills only help once one loads, so the always-on paragraph now carries the routing
itself. After the skill pointer (unchanged), one sentence. When the user says how you
should act from now on, run `memory add` at once, without asking, never your own memory
files. Cost and usage come from `usage.show`. To show something, use
`view.panel.file|diff|pr|usage|worktree` in your own thread's panel (`--focus` only if
asked). A path in a reply is a chip, and .html renders interactively. PRs go through
`pr.create` (`project.github.publish` first when the project is not on GitHub). Threads
work In place unless the user picks Fresh copy. Never tell the user to type /model or
/cost. Page verbs move every window, so prefer panel verbs. Say what you will do, not
command or skill names. Then the orchestration sentence, unchanged. Still one paragraph
with no backticks, `$` or newline.

Cost, measured with `claude -p --output-format json` (same prompt, only the append
changed): the new paragraph (1,357 bytes) costs 261 tokens more than the old line
(535 bytes) on every request. `TestSystemPrompt` checks each routing phrase and caps the
paragraph at 1,400 bytes.

## Skills

* **Entry (code-foundry)**: the description (398 of 400 characters) names the words of
  the prompts that loaded nothing: version, model, effort, usage or cost, worktrees, see
  a file, diff, page, HTML or chart, preference, remember, PR. The body (70 of 70 lines)
  adds:
  * a rule: talk about the app as the user sees it, and never tell them skill or command
    names ("say what you will do, not which command");
  * table rows for preferences (`memory add`), cost (`usage.show`, "not /cost or
    ~/.claude"), seeing a file, change, PR, page or chart (`view.panel.file|diff|pr`, an
    `.html` file) and PRs (`pr.create`, `project.github.publish`);
  * a "Showing things" section naming every panel verb, `--focus` only on request, page
    verbs only when asked, path chips and interactive .html ("no server, no browser");
  * two "Good to know" lines: In place is the default (`threads.default_worktree`), and
    the app replaces /model, /effort, /fast, /mcp, /rename and /clear (the composer's
    pickers, the MCP panel, Rename Thread, a new thread). "Every button is a command"
    became "most", as capabilities already said (control-5).
* **Help (code-foundry-help)**, 105 of 105 lines, description 397 of 400 with "asks to see
  something":
  * "Showing things in the app": a "show me" is asking, so open it in your own thread's
    panel without checking presence. `--focus` only when the user asks to be taken
    there. Something worth seeing done on your own also opens there unless a saved
    preference says not to; say so in the reply, and no `ui.notify` (the turn end
    already alerts). `ui.presence` only decides whether to mention that the window is
    in the background. Page verbs are refused from a thread no window shows.
  * "Explain first, then offer": name settings by their Settings page label, offer the
    action in the user's words ("Want me to make Fresh copy the default?"), and show
    the command only if asked.
  * "Remembering preferences" uses control-6's wording ("Remembered: …"; new threads
    follow it, threads already open get it on their next message after a restart) and
    says "never your own memory files or CLAUDE.md".
  * "Reading the source": when the ref 404s, use the `commit` from `daemon.version
    --json`, else `main`, and say so.
  * To pay for the new lines, "Where to look", Settings and the `--yes` step were
    tightened.

## Capabilities and descriptions

* `presenceRule` (the panel group's last line) says the same as the help skill; no
  "check presence before opening". The pages group adds "to show something prefer a
  panel verb".
* Surface descriptions that continued after the colon with a dangling "its" now read as
  sentences, inside `daemon.capabilities --group panel` too: "the thread's subagent
  runs…", "the thread's MCP servers…", "the thread's cost…", "the workspace's
  members…", "the pull request's summary…", "the worktree the thread runs in". The test
  refuses a surface line that starts with "its".

## Plugin asks: windows and receivers

The plugin skill's host-api.md said an ask answers `delivered: <windows>`, but the count
was receivers (control-5 left this out). Fixing the text alone would have described a
bug, so `pluginsdk.AskedResult` gains `windows` and `receivers`; `delivered` stays set
(receivers, its old meaning) for plugins that read it. An ask now needs an app window: a
CLI events stream alone no longer counts as "someone to ask". host-api.md says so, and
also that `ui.*` and `view.*` commands answer `{windows, receivers}`. It sat 8 bytes under
its 32 KiB cap, so two other paragraphs were shortened to make room.

## Getting started guide

"Start a thread" gains the composer's Model, Effort and Permissions pickers (Supervised,
Accept edits, Auto). "While it runs" gains remembered preferences: tell a thread how you
like things done, a "Remembered" notice confirms it, and you can ask what it remembers
or to forget one. The guide has no size cap in the tests (the 29,000-byte cap is the
CLI guide's); it is 4.8 KB.

## A/B (2026-10-22, isolated homes, Haiku 5.5, medium)

`make gui-build`. B was the branch daemon, A a build of main at #314; each had its own
`CODE_FOUNDRY_HOME` under /tmp and its own GUI window, with the CLAUDE* variables unset.
`project.add` refuses /tmp, so the project was a scratch folder under $HOME (README.md,
main.go, notes.txt). It was not a git repository at first; the daemon's
`project.git.init` made it one before the PR runs. The PR threads ran in supervised mode
so nothing could reach GitHub. Every prompt went to a fresh thread.

| Prompt | A (main) | B (this branch) |
|---|---|---|
| how do I change the model? | "Run `/model`", `claude --model`, settings.json | Model picker under the prompt, Settings › Threads › Model, offers to change it; no command names |
| how much has this cost? | "Run `/cost`", Anthropic Console | `usage.show`: "$0.0028 so far, 2 requests on Haiku 5.5" |
| from now on keep your answers short | "Got it", nothing saved | first wording: "Got it" (and once asked whether to save); after the iteration: `memory add "keep answers short"`, "Saved" |
| make a tiny page listing the files here and show it to me | wrote /tmp/…/files.html, opened the browser | wrote files.html in the project, `view.panel.file`, said it opened in the side panel |
| show me the worktree panel (another thread selected) | read capabilities, ran ui.presence, refused: "no window is showing this thread" | `view.panel.worktree` at once: "opened in this thread's side panel" |
| what's a worktree? | git explanation, then "each thread gets its own worktree" | first wording: same mistake; after the iteration: "a thread normally works in place… Fresh copy gets its own worktree" |
| open a pull request for this | asked for a URL to `git remote add origin`, named `code-foundry pr.create` | entry skill; committed on a branch, then asked for visibility and owner to publish (the app's publish step), no raw gh, no command names in the reply |

**One iteration.** The first ThreadPrompt said "standing preferences … go to code-foundry
memory add" and did not mention the default. Prompts 3 and 6 still missed, and a PR
reply quoted "the code-foundry skill says … `code-foundry pr.create`". The second
wording names the trigger ("from now on (always, never, keep answers short)"), asks for
`memory add` "at once, without asking", states the In place default and adds "say what
you will do, not command or skill names". Prompts 1, 2, 4 and 5 were run again on it
with the same results. No WARN or ERROR lines in the branch daemon's log.

What the runs did not show: whether a thread opens something worth seeing on its own
(none of the prompts invited it). And in prompt 5 the reply did not say the user would
see the panel when they open that thread.

## Gotchas

* The isolated GUI auto-starts a daemon with `--wait-lock` when it loses its own, so
  restarting a test daemon races the window. The window's daemon is the same binary but
  has the GUI's `PATH`.
* The isolated GUI shares the installed app's WebKit localStorage (see the GUI
  screenshot workflow): the test threads' panel entries were written there.
* The baseline A4 thread opened a page in the default browser on the test Mac.

## Daemon restart

Needed: the skills and the system prompt are written at start, and the plugin ask result
changed. Threads that exist keep their recorded system prompt until a compaction (the
skills reach them through the skills dir).
