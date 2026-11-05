# Instant threads 4: the composer

PR 4 of 4. PRs 1 to 3 gave Create a background setup, the ways out of one and the rows in the
timeline. This PR adds the composer's side and turns it on: sending from the new-thread composer
opens the thread at once. Only that send goes background. PR threads, Ember, theme ask and the CLI
still wait. The switch is the last commit, so nobody gets a failed thread with no way out.

## What changed

- `sendDraft` passes `background-setup` and `draft-json` on thread.new and thread.new-like.
- `lib/setupDraft.ts`: the snapshot, versioned and read defensively. `stores/setupActions.ts`:
  Try again, Cancel and Edit over the `thread.setup.*` commands.
- `components/thread/SetupNote.tsx`: the note in FailedPromptNote's slot.
- `ThreadComposer`: Cancel in Interrupt's place, the placeholders, and a setup someone waits for.
- `thread.interrupt`'s presenter cancels a background setup, so a user's chord does too.
- Follow-ups from PR 3's review, below.

## Decisions

- **Edit selects the composer first, then asks the daemon.** Discard can take a while with a worktree
  to remove, and the thread going must never be seen from inside it. So the composer shows at
  once, read-only (`phase: "starting"`), the row leaves (`hideThread`), and the draft fills when the
  reply comes. The pane is gone before the stream could end with NOT_FOUND, so there is no toast
  and no "not found" flash to suppress. A refusal puts the thread back, with the reason on its error
  line.
- **`hideThread`, not the daemon's `Removing`.** `Removing` is not on the API, and the row has to
  leave before the cleanup. Whatever still arrives for such a thread is dropped until its Removed.
- **`noteSentFrom`.** The snapshot's target is only known after the reply, and a thread's own fields
  name its primary, not the composer it came from. Without the note a set whose primary is not the
  target passed through the primary's composer. After a reload it falls back to the thread's fields.
- **What was typed in the thread's composer moves too**, after the rest. Edit must not lose it.
- **Over the cap the prompt and citations go, the options stay**, and `first` brings the prompt
  back. "" if even that will not fit. The cap is bytes, as the daemon counts them.
- **The snapshot keeps its attachment ids** and the chips are remapped to the new ones. `first` goes
  through `draftOfSent`, as a failed message's Edit does.
- **A target that went falls back to the nearest project of the set, else home**, with the place
  fields dropped and the prompt and options kept. The text keeps its project tags: dropping one
  could lose words, and the prompt is the one thing that must survive.
- **"Too late" is a `toast.info`.** The composer's notice line is amber, which is alarm.
- **Blocking setup: a short reason in the placeholder, typing allowed.** The draft keeps what is
  typed; only Send is off. Interrupt's key does nothing there.
- **A shown checklist stays by remembering what was shown, not by times** (`setupShown` in
  `stores/thread`, read by `setupView` and `setupRowPhase`). A late snapshot cannot be fixed from
  times: the row was right when it showed. It is per thread, not per run, so a retry keeps the
  failed rows up, and it is forgotten on leaving the thread with the folds, since nothing is on
  screen to vanish.
- **Stopped steps keep their state until the setup says how it ended.** A fetch or add the setup
  stopped used to be reset, or failed with `context canceled`, while the phase was still RUNNING.
  Now it stays running with its time: a cancel puts it back to pending, and the next start fails it
  with the restart's reason. That fixes the wrong reason and the 17ms gap at the source.
- **A restart is told by Setup.error's text**, `SETUP_RESTARTED` in `lib/threadSetup`, as status
  reasons are. A step that really failed beside it keeps its own words.
- **`ThreadSetupStep.existing` is on the API**: nothing else tells "Using the branch dev" from
  "Named the branch dev".
- **File tabs: `heldFor`, set in `openFileInPanel`**, the one place every opener goes through. A
  held tab is read-only and says so. `useFileHold` moves it when it mounts after the landing, so a
  hidden tab moves when it is shown: only a mounted tab can write. A file not in the worktree stays
  read-only for good.
- **Archive on a background setup cancels it**, cleanup included, and asks nothing: there is no
  Claude to interrupt and a retry brings the thread back. A blocking one keeps its wait and confirm.
- **`EmberTaskThread.setup`**, so workers read the setup words. Descendants did not need it.

## Gotchas

- `thread.setup.cancel`'s result JSON has the same `keptWorktrees` key as discard's, so one parser
  reads both.
- A test harness that keeps the thread store across tests must clear `setupShown`, or a row
  shows from the first moment.
- `playwright cli`'s allowlist also stops `blob:` images, so attachment thumbnails look broken
  there whatever the code does. A data URL of the same bytes loads.
- Clearing every interval in the page from an eval stops the app's shared clock: the sidebar then
  reads "Setting up 0s". It looked like a bug for a while.
- A daemon's HOME is not the shell's: `export HOME=` in a driving shell also breaks `playwright cli`.

## Accepted

- The note says "your message" on a CLI thread made with `--background-setup` and no prompt.
- Discard's reply is the only way to the snapshot, so a thread sent before a reload waits in its
  primary's composer for a moment.

## Seen end to end

A `--dev` daemon on a scratch `HOME` and `CODE_FOUNDRY_HOME` under `/tmp`, `cmd/fakeclaude` first on
`PATH`, two scratch repos with bare remotes behind an `ext::` script that sleeps; the GUI under
Vite in WebKit, driven with `playwright cli`, with a sampler recording every change to the rows.

- Instant open: `sendDraft` back in 89ms on a 6.4s fetch, the thread selected, then "Set up in 7.0s".
- Warning, an unreachable origin: "Set up in 1.0s · using origin/main from 4m ago".
- Failure, `--branch main` with the main checkout on it, two projects: "Using the branch main", a
  box per project, the note. Try again after moving the main checkout off it: went on from the
  failed step, rows up throughout, no header in the running rows.
- Cancel with a worktree to remove, a second project's fetch running: 254ms, the rows went from
  running straight to cancelled, worktree and branch gone, the remote's script gone. Try again:
  no gap, Claude got both messages.
- Edit, with an attachment, a citation, two projects, a primary that is not the target, a branch and
  other model, effort and permission: every field back, staged path reused, focus in the prompt,
  no toast, no "not found", row gone in the same tick, `thread get` not found, no tombstone.
- Remove: its usual confirm.
- A message during setup: `queued`, Claude got it.
- SIGTERM and `kill -9` during a fetch: "Setup stopped when Code Foundry restarted" in the row, the
  sidebar and the note, no `context canceled` anywhere, the queued message kept. Try again: done.
- Archive during a 25s fetch: 0.06s, cancelled, archived, the remote's script gone.

The built app (`make gui-build`, the Wails window) on the same scratch homes, dark and light: the
composer during a setup, the failed and cancelled notes, and a real click on Edit, both with a
snapshot and on a CLI thread that kept none. There the attachment's tile and chip show the image,
which `playwright cli` cannot.

Real Claude, Sonnet 5.5 medium, scratch `CODE_FOUNDRY_HOME`, real `HOME` (scratch `HOME` says "Not
logged in"), a throwaway repo under `~`, deleted after, through the GUI composer on a 12s fetch:
send back in 70ms, the title swapped in at 4.4s (italic to plain), the branch
`fix/login-empty-password-crash` at 4.5s, and the message queued during setup cleared its flag at 16s,
when Claude had it; it answered both. The default utility model, `claude-sonnet-4-6[1m]`, was
refused on this account ("Usage credits required for 1M context"), so two earlier runs took the
`cf/<id>` fallback and kept the provisional name, as designed; the run above set `models.utility` to
Sonnet 5.5 in the scratch home. A failing namer does nothing else to the setup.
