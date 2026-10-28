# Composer failed-prompt notice (2026-10-28)

PR B of the prompt-recall series. A user asked for up-arrow prompt recall; one real reason was
"the turn failed (auth, timeout, Claude did not start) and I want to resend". This fixes that
case where it happens: a one-line notice at the top of the thread composer card with Edit and
Send again. GUI only, no daemon change, no restart needed.

## What it does

- `components/thread/FailedPromptNote.tsx`, placed after RetryNote in `ThreadComposer.tsx`:
  CircleAlert in the error text colour, "<reason>, so your message was not sent." in
  `text-body-sm` (it truncates; the buttons never wrap), a bottom border in the card's border
  colour. Edit is a ghost xs Button (muted text); Send again is a secondary xs Button on
  `bg-cf-control-hover`, not the accent. No close button.
- Reasons: "Claude did not start", "Claude stopped before replying", "The request failed"
  (with the turn end's subtype, underscores as spaces, in parentheses when it is not empty or
  "success"). Fallback for any other error item: "Your message didn't go through."
- The transcript is unchanged: the prompt's bubble and the error row stay as before.

## The rule (lib/failedPrompt.ts failedPrompt, table test beside it)

Walk back from the end of the log over the thread's own items (subagent items are skipped) to
the last user message. The notice shows for that message when:

- there is no assistant text and no command output after it (blank text does not count),
- the thread is not working (busy or starting, with a live process), no prompts are docked,
  and the transcript is not missing,
- the message is not a wake message and not still queued,
- and one of these holds: an error item starting "Claude did not start" or a fresh status
  error "did not start" -> did not start; an error item starting "Claude stopped" -> stopped;
  a turn end that is not an interrupt with is_error or a non-success subtype -> request
  failed; any other error item -> fallback; a fresh status error with another reason (a run
  the daemon lost: process_ended turn end, no error item) -> stopped.

"Fresh" means the status changed at or after the message was created. Without that, a stopped
thread's old "did not start" status would make a just-sent message look failed for the moment
before its state turns to starting.

A user interrupt (turn end interrupted) and a close of a busy thread (process_ended, no error
item, no error status) are deliberate, so they show nothing.

## Edit and Send again

- Send again (`stores/threadActions.ts resendThreadMessage`) invokes thread.send with the
  item's text, its staged attachment paths and its composer text, exactly as it was sent, so
  a stopped thread starts as for any send. The draft is left alone; a failure shows on the
  draft's error line.
- Edit (`editThreadMessage`) turns the item back into draft text (`draftOfSent`): the composer
  text (or the text when there is none), each image chip remapped to a new draft attachment,
  and each citation link turned back into a draft citation (a new id, `putCitation`). File,
  skill, thread and PR tags carry over as they are. Attachments are staged again cheaply:
  each staged file is read back from the daemon (`readAttachmentFile`) and added with its
  staged path already set (`compose.ts addStagedAttachments`), so the next send reuses the
  path and uploads nothing. If the daemon no longer has a file, it is left out (its chip
  dropped) and the notice line says so. When there is already a draft, the prompt goes after a
  blank line. The editor is focused with the caret at the end (`focusCollapsed`, one frame
  later, after the editor has rebuilt from the new value).

## Hiding on send (stores/failedNotice.ts)

The notice is hidden while the draft's phase is not idle. On top of that, every send from
this window (`sendThreadDraft` and Send again) records the highest ordinal in the log when it
starts (`holdFailedNotice`). A failed prompt at or below that ordinal stays hidden, so the notice
does not flash between the RPC returning and the new item arriving on the Watch. A send that
fails drops its hold and the notice comes back. A message sent elsewhere (the CLI) hides it
when its item arrives, because the rule then finds a newer last prompt.

## Mock and e2e

- The mock's `crashed` state now matches the daemon's Send to a stopped thread whose claude
  did not start: the message's item (image chip, file tag, skill: `CRASHED_PROMPT`), the
  error item, and the synthetic process_ended turn end (`turn-synth-<id>`). As with the real
  daemon, the timeline therefore shows "Interrupted after 1.0s" above the error.
- `POST /__mock/thread/fail-turn[?subtype=…]`: the next message's turn ends with an is_error
  turn end (default error_during_execution) before any text.
- `e2e/composer-failed-notice.spec.ts`: the notice in the crashed state (one line, tabbable
  buttons, Send again's exact thread.send args, gone after the send and the reply), Edit
  (tags, attachment tile, focus, appended after a draft, sent with the staged path), a failed
  turn and a later send clearing it, and the screenshots (SHOTS=<dir>, WebKit, both schemes).

## Gotchas

- WebKit's Tab skips buttons unless full keyboard access is on; the spec uses Alt+Tab, like
  the other specs.
- `pnpm run e2e -- <spec>` passes the `--` through to Playwright, which then runs the whole
  suite. Use `pnpm exec playwright test <spec>`.

## Not covered (would need the daemon)

Claude Code reports API failures such as auth or invalid key as a synthetic assistant message
(model "<synthetic>"), and the daemon projects that as an ordinary text item. By the rule,
that text counts as a reply, so the notice does not show for those turns. The GUI cannot tell
a synthetic error reply from a real one without a daemon field (for example a flag on the
text item, or the turn end's error list filled in). Left as a follow-up.
