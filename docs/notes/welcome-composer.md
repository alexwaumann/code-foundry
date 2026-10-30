# The welcome composer (2026-10-30)

The last of the first-run series (#414 the welcome page, #415 the No project composer as
home). With zero projects the home composer is the first-run welcome: its heading reads
"Welcome to Code Foundry" and its prompt is prefilled, never sent, with the tutorial prompt
naming the page the daemon placed:

> I just installed Code Foundry and have no projects yet. This is the welcome tutorial:
> open the page `<home>/pages/welcome.html` in the side panel and walk me through it.

The wording is welcome-page.md's measured one ("and walk me through it" routes to the help
skill; without it the thread shows an inline card). Sending it is a plain No project
thread.

## What changed

* **Daemon:** `HealthService.Version` reports `welcome_page`, the absolute path
  `skills.WelcomePath(paths.Pages())` (`api.NewHealth` takes it). The GUI had no way to
  know the daemon's home: no info RPC carried it, and the plugin and memory directories
  are other features' words. Version is the existing info response; a table test covers
  it (`TestHealthVersion`).
* **GUI:** `stores/welcome.ts` holds the path (read once, `api/health.ts welcomePage`), the
  "welcome" condition (projects store loaded and empty; no history check), the prompt
  text, `prefillWelcome` and `startWelcomeSync` (App.tsx). `Composer.tsx` shows the
  heading without the project switcher and asks for the prefill while the welcome shows.
  The Work in row and everything below the prompt are unchanged.
* **Mock:** its Version answers with `WELCOME_PAGE`.

## Rules

* **Prefill once per window, only into an empty draft.** The decision is made the first
  time the welcome shows with the path known: an empty draft gets the prompt, a typed one
  is left alone. Either way it is not made again in that window, so a prompt the user
  cleared stays clear, and coming back home after sending it (still zero projects) shows
  the welcome heading with an empty prompt. A reload decides again.
* **The first project clears an untouched prefill.** `startWelcomeSync` watches the
  projects store, not the composer: adding a project from the dialog moves the window to
  the Projects page first, so the composer is not mounted when the project arrives.
  "Untouched" means the draft's text still equals the prompt; an edited prompt stays.
  The heading reverts on its own (the condition is derived).
* **Only the home composer.** The welcome is `target.kind === "home"` (No project, not a
  like draft or a workspace).

## Gotcha: the caret of an outside value

PromptEditor's "a value from outside: caret at the end" read
`editor.state.doc.content.size` while building the chain, before `setContent` ran: the old
document's size. Into an empty prompt that is position 1, so the caret sat before the
prefilled text and the first keystroke landed in front of "I just installed". It now
selects `TextSelection.atEnd(tr.doc)` inside the chain. Any value set from outside the
editor had it; the welcome made it visible. The e2e spec types
without clicking first, and fails without the fix.

## Verified

* `make check`.
* Composer.test.tsx: the exact prompt text; heading and prefill for zero projects, with a
  project, before the projects load, and with a typed draft (not replaced); no switcher in
  the welcome heading; a cleared prompt stays clear on remount; the first project clears
  an untouched prompt and keeps an edited one, the heading reverting in both.
* Playwright (`e2e/welcome-composer.spec.ts`, WebKit, mock `POST /__mock/empty`): heading
  and the prefilled text with the mock's path, nothing sent until Enter, then exactly one
  `thread.new` with `no-project` and the prompt; the first project through the Local folder
  tab clears an untouched prompt and keeps an edited one. home.spec.ts's zero-projects test
  now expects the welcome heading; welcome-page, no-project, compose, composer-threads and
  prompt-history-picker specs still pass.
* Live: `make build && make gui-build`, the app on an empty scratch home. The window opened
  on the welcome with the scratch home's `pages/welcome.html` in the prompt; Enter started
  a No project thread (Sonnet 5, medium, the default) that opened the page in the side
  panel and replied with welcome.md's two prescribed lines exactly. Back home the heading
  was still the welcome with an empty prompt; adding a folder through the Add Project
  dialog turned it into "What should we build with No project?".
