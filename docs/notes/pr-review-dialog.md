# PR page: reviewing through a dialog

Part of the pull request page redesign (agreed sketch v11). Review is no longer a "Review ▾"
menu that opens an inline composer under the header: pressing Review opens a calm dialog, the
merge dialog's sibling. The Diff tab gets the same button.

## What changed

| File | What |
|---|---|
| `components/pr/ReviewButton.tsx` | a plain button (no menu, no chevron): Review, primary when the viewer's review is requested, or the "You approved / You requested changes / You commented" chip; busy in the verdict's words. `PrDiffReviewButton` is the Diff tab's, reading the detail itself |
| `components/pr/ReviewDialog.tsx` | the dialog, mounted once in `App.tsx` (and in the PR test harness) |
| `stores/reviewDialog.ts` | which pull request it is open for, the opener, and each pull request's unsent draft (verdict + text); `registerOwnDialog` |
| `components/pr/review.ts` | the verdict copy (segment, confirm, busy words, placeholder), `initialVerdict`, `reviewHint`, `reviewRequested`, `OWN_PULL_REQUEST_NOTE` |
| `stores/prPanel.ts` | `reviewing` holds the verdict in flight (was `true`), `useReviewingVerdict` |
| `surfaces/prdiff.ts` | fills PrDiffView's `review` slot |
| `PullRequestSurface.tsx`, `ReadinessBox.tsx` | the review composer and `onReview` gone; Ask stays inline |
| `PrReviewComposer.tsx` (+ test) | deleted; its tests' intent moved to `ReviewDialog.test.tsx` |

## Decisions

- **One dialog for the window, keyed by pull request.** The merge dialog is per button (two panes
  showing one PR open only the pressed button's). The brief asked for one dialog shared by every
  surface showing the pull request, so it is a single host in `App.tsx` reading the detail from
  `pullRequestDetailResource`. Any surface (the header, the Diff tab) opens it through the store.
  It shuts when the detail goes or the pull request stops taking reviews (`reviewVisible`), or
  when a review of it is in flight: the store does it where those change (dialog-open-flags.md),
  so a stale "open" never keeps a guarded question waiting.
- **The draft lives in the store, not the dialog.** Submitting shuts the dialog at once and runs
  `submitReview` (pr.review, unchanged: the same args, the generic failure toast with GitHub's
  message, the detail read at once and waited for on success). Success clears the draft; a refusal
  keeps it, so pressing Review again shows the verdict and text. Cancel and Escape keep it too
  (the sketch keeps the text on cancel). The dialog does not reopen itself on failure: the toast
  says what happened, Review brings the text back.
- **Which verdict it opens on** (`initialVerdict`): an unsent draft's, else the viewer's previous
  review (reopening from the chip), else Comment on their own pull request and Approve otherwise;
  never one GitHub refuses here.
- **Own pull request.** Approve and Request changes are disabled segments and one caption under the
  control says why ("You can’t approve or request changes on your own pull request."). The two
  per-verdict tooltip reasons of the menu are gone. An unknown viewer ("") disables nothing; GitHub
  refuses and the toast says so, as before.
- **Tones, never an error's look.** Badge: success / error / neutral surfaces (`statusPill`), the eye
  for Comment as in the sketch. Confirm: Approve the merge dialog's success fill; Request changes the
  error text on the error surface with an outline (not the destructive variant); Comment the default
  (primary) button.
- **Keys.** `onOpenAutoFocus` puts the caret at the end of the comment box. cmd+Enter submits from
  anywhere in the dialog (`composerKeyAction(..., "cmd-enter")`, IME-safe), Enter is a newline,
  Escape cancels through Radix (`onEscapeKeyDown` lets an IME's Escape and stopping dictation go
  first). Request changes and Comment wait for non-blank text; the footer hint says what is missing,
  else the keys.
- **Focus back.** WebKit does not focus a clicked button, so Radix had nothing to return focus to
  and it fell out of the pane. `openReviewDialog` takes the opener; `onCloseAutoFocus` focuses it
  (busy now, or the chip), or the pane when it is gone.
- **Dictation stays.** The composer had a mic; the dialog has the same (`useComposerDictation`,
  `DictationMic`, `DictationNote`), and submit waits for the last phrase.
- **Busy.** While a review is submitted the button says "Approving…", "Requesting changes…" or
  "Commenting…" with a spinner, `aria-busy`/`aria-disabled`, and opens nothing. That is why
  `reviewing` now holds the verdict.
- **Diff tab.** `PrDiffReviewButton` (size `sm`, h-6, for the 40px bar), primary by the same rule
  as the header (`reviewRequested`, the readiness row "Your review is requested").

## Differences from the sketch (v11)

- A footer hint left of Cancel (the keys, or what a blank body waits for) and the dictation mic:
  the inline composer had both, and a disabled confirm with no reason would be a puzzle.
- The busy button keeps the app's outline look with muted text instead of the sketch's 80% opacity.

## Gotchas

- `components/ui/button` always carries `aria-invalid:border-destructive`; a test asserting "not
  destructive" checks `data-variant` and `bg-destructive`, not the substring.
- jsdom ignores the modal's pointer blocking; the "merged meanwhile" test merges through the world
  and re-reads the detail rather than clicking Merge under the dialog.
- The Diff tab's slot span renders even when the button renders nothing (no detail yet, read-only,
  merged); `empty:hidden` on it keeps the bar's gap from leaving a hole.
