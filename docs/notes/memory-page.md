# Settings › Memory (2026-10-22)

The app memory (memory-dir.md) gets its own Settings page: every standing preference
threads were told to remember, when, and by which thread. Read and forget only. One
small daemon change: the memory toasts carry a link to the page.

## Decision

Alex, 2026-10-22, sketch `docs/sketches/model-phase1` (not committed) variant B: a page of
its own, not a section on General (variant A, rejected). No add control: adding happens by
telling a thread. The sketch put Memory second in the nav; the brief put it after Skills,
which is where it is (the last of the GUI-drawn pages).

## Page

* `guiPages.ts` entry `memory`, lucide `BrainCircuit`, description "What threads have been
  told to remember about this app and how they work in it." One section, `remembered`,
  listed in the page's sections so the settings search finds it ("remembered", "memory").
* `components/memory/settings/`: `MemoryPage` (PageHead, then the section; it runs
  `loadMemory()` on open) and `RememberedSection`.
* **Section head**: "Remembered", "Every thread in every project reads these before its
  first action.", and at the right "N of 40" (`maxEntries` from the snapshot) plus a
  "Forget all" outline button, hidden at 0. `SectionCard` gained an optional `aside`
  (the right side of the heading, bottom-aligned); nothing else passes one.
* **Rows**: the text (`text-label`), under it `text-caption-sm` "Remembered <when> · by
  <thread>". A trash icon button at the right, muted and always visible, tooltip
  "Forget". Rows highlight on hover (`hover:bg-accent/40`).
* **When** (`lib/memory.ts rememberedWhen`): "just now", "N min ago", "today",
  "yesterday", "N days ago" (under a week, local calendar days), then "on Oct 14"
  ("on Oct 14, 2025" in another year). An entry with no `created` (a file added by hand)
  reads "Added by hand".
* **By** (`memoryBy`, lineage-by-id.md's rule): resolved by the thread id against the
  thread list. In the list: its current name (its id while unnamed), a link that selects
  the thread (which leaves Settings); archived, the same link struck through with
  " (archived)" (an archived thread still opens). Not in the list: the recorded
  `thread_name` (else the id), struck through, not a link, " (removed)". No thread (the
  user's terminal, the GUI, an imported line): no "by" part.
* **Footer** in the card when there are entries: a `CircleQuestionMark` and "Applies to
  threads started from now on. Facts about a project stay in Claude's own memory files."
* **Empty**: "Nothing remembered yet" (semibold), the sentence, and the example
  "“from now on, open PRs as drafts”" as a muted pill.
* Loading, a failed Get with nothing to show (red line), a daemon older than
  MemoryService ("Restart it to see this page"), and a snapshot whose last read failed
  (amber line above the last good list) each have a line.

## Actions

* **Forget** runs `memory.remove` with the entry's **index** (`{entry: "2"}`): digits in
  range are always an index for the verb, so it is unambiguous for the snapshot shown;
  text could match a different entry by substring or be all digits. The race (the memory
  changed between the snapshot and the click) is the same as any list; the snapshot is
  live, so the window is an event's latency.
* **Forget all** runs `memory.clear` through `runCommand`, so the daemon's Confirm
  ("Forget every remembered preference? New threads get none.") is the standard dialog.
* Both report through runCommand's usual success toast ("Forgot: …", "Forgot 4
  preferences."). The GUI is the user, so the daemon sends no "Forgot:" notify of its own.

## Live

`stores/memory.ts` replaces the no-op `memory` handler in `stores/events.ts`: each event's
snapshot replaces the store's. The page's Get on open applies only if no event arrived
while it ran (an event counter), so an older read never overwrites a newer event. A
failed Get keeps a snapshot it already has. Selectors are narrow: the row list subscribes
to the files (shallow), each row to its own entry, the provenance to the one thread's name
and archived time.

## Toast link

`UiIntent.Notify` had title, body and level only. Added (proto `ui.proto`):

```
string link = 4;        // "settings:<page id>"; a window ignores a target it does not know
string link_label = 5;  // the button's words; empty: "Open"
```

`memoryNotify` (`internal/command/commands_memory.go`) sets `settings:memory` / "Show in
Settings" on both the "Remembered: …" and "Forgot: …" toasts a thread's change shows.
The GUI maps them (`api/ui.ts`, only when set) and `stores/intents.ts` turns a link that
`stores/notifyLinks.ts` knows into the sonner toast's action button. `notifyLinks.ts` is a
registry (`settings` is its one kind) and calls the new `views.openSettingsPage(page)`.
`view.settings` was not used: its only arg is `--focus`, and a page argument would have
moved every window on the toast's click, which should move only the clicking one.
`ui.notify` (the CLI verb) did not gain a `--link` flag: nothing asked for it.

## Mock

`mock/memory.ts` (`MockMemory`): four seeded entries (by s-1 "Refactor sidebar tree" two
hours ago, by s-3 "Fix resize race" yesterday, from the user's terminal three days ago, by
s-gone "Usage page polish" eight days ago, a thread the mock does not have); MemoryService
Get/Watch; the EventService memory source (initial snapshot and the default sources); the
`memory.*` commands with the daemon's remove lookup and the clear confirm. Controls:
`POST /__mock/memory?set=empty|seed`, `POST /__mock/memory/add?text=…&thread=s-1` (a
thread's add: the entry plus the linked toast), `GET /__mock/memory`.

## Tests

* Go: `TestMemoryCaller` now checks every notification carries the link and label.
* vitest: `lib/memory.test.ts` (by: live, unnamed, archived, removed, removed unnamed;
  when: every bucket and another year), `stores/memory.test.ts` (event replaces, Get sets,
  an event during a Get wins, failed Get, outdated daemon), `stores/notifyLinks.test.ts`,
  `stores/intents.test.ts` (the action button opens the page; no link and an unknown link
  give none), `api/mapping.test.ts` (link and the "Open" default),
  `RememberedSection.test.tsx` (provenance lines, link vs plain text, opening a thread
  leaves Settings, Forget by index, Forget all, empty state).
* e2e `memory.spec.ts`: the list with provenance and the tooltip; an archived thread and
  the link opening s-1; Forget removes the row live; Forget all cancel then confirm; the
  empty state and an entry arriving live; the thread's toast and its Show in Settings
  button; the settings search. `SHOTS=<dir>` writes dark and light, with entries and
  empty.

## End to end (2026-10-22, isolated home)

`make build`; the daemon with `CODE_FOUNDRY_HOME` in a scratch directory, the branch's
`bin` (and `claude`) on `PATH` and no `CLAUDE*`/`CODE_FOUNDRY_*` variables; the branch's
GUI as the Vite dev server pointed at it (phase2-integration.md's recipe), driven by
Playwright in WebKit.

* `memory add Always explain git terms when you use them` and `memory add Open PRs as
  drafts` from the user's terminal: the page listed both, "Remembered just now", no "by",
  "2 of 40".
* `thread new --no-project --name "memory page live"` (Haiku 5.5, medium, no prompt, so
  no turn). With Settings closed, `memory add` with `CODE_FOUNDRY_THREAD` set to it
  showed the toast "Remembered: Keep commit subjects under 72 characters / By thread
  "memory page live". / Show in Settings"; the button opened Settings › Memory with the
  entry last, "by memory page live" (dark and light).
* `memory add` as `s-000000000000` (a thread the daemon never had): the entry read "by
  s-000000000000 (removed)", struck through and not a link (no name was recorded).
* The first row's trash removed it from the daemon (`memory show` listed the other three);
  the "memory page live" link selected the thread and left Settings.

No ERROR lines in the daemon log. The thread was removed, the daemon and Vite stopped and
the scratch home deleted.

## Daemon restart

Needed for the toast link only (the proto field and `memoryNotify`). The page itself works
against the daemon from PR #319; an older daemon's toasts just have no button.
