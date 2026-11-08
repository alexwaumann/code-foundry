# Page asks: fuzz fixes

Four findings from the settings fuzz pass after v0.21.5 (#603, #610 brought them in or made
them common).

## What was wrong

1. **A yes held the next question back.** `bridgeHost.ts` put a 5 s gap after every question
   and counted every question toward 3 a minute, yeses included. A PR board's second Merge,
   pressed a second after Allow on the first, was refused "this page is asking too often; ask
   again later", with no time to wait. #610 put many everyday verbs behind a question
   (`git.pull`, `pr.comment`, `skill.*`, ...), so this hit any page with several buttons.
2. **The welcome page's failures were silent.** It reported errors with `alert()`. Wails 3.1.0's
   `WKUIDelegate` implements none of the JavaScript panels (`alert`, `confirm`, `prompt`) and
   the app adds none, so in the app's window `alert()` does nothing. Cancel on the Dictation
   download then a quick retry: the "too often" refusal went nowhere and the switch stayed off.
   The download branch also did not treat `declined` as a no.
3. **A command's own refusal reached a page as `unavailable`.** The daemon sends a
   `command.FailedError` as FailedPrecondition with a `CommandFailed` detail;
   `bridgeErrorOf` read only the code, so a user-only setting's refusal looked like "no such
   verb" to a page following `reference/errors-and-limits.md`.
4. **The user-only refusal spoke past its reader.** "<key> can only be changed by the user;
   they can change it in Settings" read oddly to the person typing it in a thread's terminal,
   and named no page, so an agent guessed the row's name.

## The fix

1. Only a question that ended without a yes (a no, a dismiss, the page giving up with
   `cf:cancel`) is recorded. The gap runs from the last of those, and 3 of them in a minute
   hold the next back until the oldest is a minute old. A yes records nothing. The refusal
   says how long: "this page is asking too often; ask again in 4 s" (whole seconds, rounded
   up, the longer of the two waits). One question open at a time stays as it was.
2. welcome.html: a `useProblem` hook per control group; a failure shows as a red caption line
   (`role="alert"`) under the control that made it, and is cleared on the next try. `declined`
   is ignored everywhere (memory.clear asks too), not only on `settings.set`. `project.add`'s
   hint is a muted line under the button. `TestWelcomeHasNoAlert` keeps `alert(` out.
   The pages skill says it once in SKILL.md's Errors line and in errors-and-limits.md (with
   `confirm()` and `prompt()`, which do nothing either).
3. `bridgeErrorOf`: FailedPrecondition with a `CommandFailed` detail is `failed`; without it
   (no thread, not in this context) still `unavailable`. InvalidArgument stays `invalid` with
   or without the detail: it is still a wrong arg to fix.
4. "<key> can only be changed by hand, in Settings → <Page> → <Row>; a command from a thread
   (its terminal too), a page or a plugin cannot change it". Page and row come from the
   schema (`GetSchema` already ran to find the field).

## Decisions

- **No pronoun in the refusal.** One text reaches a model in a thread, a person in a thread's
  terminal, and a person behind a page. "You" tells a model it may change it; "the user" talks
  past the person. "By hand, in Settings → …" works for both: the model passes the place on,
  the person goes there. "(its terminal too)" is why the shell with `$CODE_FOUNDRY_THREAD`
  counts as the thread's.
- **A yes is not throttled at all.** Spam is a page asking until the user gives in; that is
  questions answered no. A page asking again right after a yes is gated by the user's press in
  the frame (`gesture`) and by the guarded dialog (Cancel focused, the confirm button off for
  a moment and until every key and pointer is up), so the press that gave the yes cannot
  answer the next question.
- **A page's `cf:cancel` counts as a no.** A page opening and withdrawing questions in a loop
  is the spam case too.

## Gotchas

- The drive harness's allowlist blocks `blob:` module URLs, so `/cf/jsx.js` pages (the welcome
  page) do not render under `playwright cli`.
