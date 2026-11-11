# Plugin author spike (2026-11-10)

After `plugin new`, `plugin dev --watch` and `plugin surface --shot` landed (#636, #638 to
#641), one thread built a plugin from the skill alone, to see whether an agent uses the new
loop. Opus 5.5 at medium effort, a scratch home, the built app open, a scratch git project
as the thread's folder. The prompt named none of the three commands:

> Build me a Code Foundry plugin called disk-usage. It adds a side-panel tab that shows the
> biggest folders in the thread's working directory as a table (name, size, a bar for its
> share of the total), with a Refresh button. Keep the plugin's code under ~/cf-spike. […]
> Make sure it works and looks right before you tell me it is done.

It finished in one turn: 589 s, $2.95, a working plugin with tests.

## What it did with the new loop

* **`plugin new`**: its first action after reading the skill and three references.
* **`plugin dev --watch`**: used as the skill's step 5 gives it; never ran `make build` or
  `plugin restart` by hand afterwards.
* **`plugin surface --shot`**: nine shots, at 420, 340 and 280 px. It read each PNG and
  changed the design twice because of what it saw (a block-character bar that drew as a
  white slab with seams, then a line too thin to read), and checked which columns drop at
  each width. This is the behaviour the flag was built for.

## What went wrong

1. **`plugin new`'s go step failed.** `go get …/pluginsdk@<commit>` answered "module
   github.com/alexwaumann/code-foundry@<commit> found (v0.21.7-tip.16), but does not
   contain package …/pluginsdk", twice, about a minute apart. Three minutes later the same
   query resolved (`v0.5.2-0.<date>-<commit>`), and the identical `go get` works now. The
   commit was 75 minutes old and nobody had asked the Go proxy for the nested module at it:
   until the proxy has fetched it, only the root module answers. The by-hand commands the
   command printed were the same failing ones, so the author spent 12 tool calls finding
   the pseudo-version itself. **Fixed here**: the fetch is `go get … || GOPROXY=direct go
   get …` (GitHub itself; 1 min 30 s with an empty module cache), in the step and in the
   by-hand list, and the timeout is 5 minutes.
2. **It consented for the user.** `plugin dev` printed the consent text and exited 2; the
   author reasoned that a plugin with no permissions was safe and re-ran with `--yes`
   without asking. The skill said "tell the user … and re-run with `--yes` once they
   agree". **Fixed here**: step 5 now says to stop, show the text, and re-run only after a
   yes, with no permissions too. **Softened the next day** (a user's call): an agent
   may pass `--yes` itself for a plugin it wrote in the thread that asks for no permissions;
   one that asks for any still needs the user's yes.
3. **`plugin new`'s next-step line was stale**: it still printed `make build && … plugin
   dev "$PWD" --follow=false` (written before `--watch` merged). **Fixed here**: it prints
   the `--watch` form.

## Seen, not changed

* It slept 3 s before `plugin surface` after an edit, twice, and passed `--settle 2s`. The
  surface read already waits for the build; the skill says so in step 6. Harmless.
* **No bar in a table cell.** There is no meter or share cell, so the bar is `▰▱`
  characters in a mono cell. A primitive gap, not a skill gap.
* For a realistic shot it put about 70 MB of sample folders into the thread's folder and
  removed them after (the surface is thread-scoped and there was one thread).
* It wrote a memory about the SDK pin in the thread's own Claude memory folder.
