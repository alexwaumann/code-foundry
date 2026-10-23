# Ember: the last text is the reply (2026-10-23)

Text only: Ember's `rules.md`, `soul.md`, its skill, the package comment and their
tests. No change in daemon behaviour.

## Why

A parallel GUI change (`cf/ember-reply-fold`) folds every text in an Ember turn but the
last into the "Worked for" row with the tool calls. Replies no longer stream: they show
when the turn ends, or when it waits on the user (the text before a pending question or
permission shows). The old rule, "Write nothing between tool calls", existed so that
text between tool calls would not clutter the chat. With the fold, that text is hidden,
so the rule now states the fact and what follows from it.

## What changed

- **How you talk.** The user sees only the turn's last text and any page shown inline.
  Earlier text is folded away with the tool calls, so Ember may think in text, but the
  reply must stand alone and repeat anything the user needs from earlier text. The 400
  and 800 character limits apply to that reply. The asking rule now says to end the turn
  after the one question, because the text before a pending question is what shows.
- **view.inline.** One bullet tells Ember to show more than words by writing an .html
  page that links /cf/theme.css in `$CODE_FOUNDRY_PAGES` and running `code-foundry
  view.inline <path>` (`code-foundry help view.inline` has the flags). Ember's rules
  already allowed the CLI; this makes the verb known. Writing its own pages is the one
  file write the edit rule names as allowed ("your pages aside"). Board rendering is
  left for a later experiment.
- **Edits on an explicit ask.** The edit rule now applies "on your own initiative".
  When the user explicitly tells Ember to do a piece itself, it does that piece (edits
  files, runs what the piece needs), says so in its reply, and delegates the rest.
  Every other delegation rule is unchanged, research included. The skill's opening line
  and `soul.md`'s parenthetical now say the same. `soul.md` is written only on first
  enable, so existing users keep their copy. SOUL.md still cannot loosen the rules.
- **Skill.** Step 5 (what you started) and wake step 5 (tell the user) now say the
  user sees only the last text. Step 1 ("Scope it; never answer it yourself") stays as
  it is: the explicit-ask exception covers a piece the user hands Ember, not Ember
  answering on its own initiative.

## Fitting the caps

- `rules.md` went from 5763 to 6135 bytes; `TestPrefixAndSystemPrompt` fails above 6144.
  The new text was paid for by shortening the wording, with no rule dropped: the intro's
  epoch sentence, the task-card bullet, the tests-claim bullet, the memory bullet, the
  filesystem-search bullet, the budget-stop bullet, the cost bullet, the relay bullet
  and the "Where things are" memory line. The next addition to rules.md will need a cut
  or a raised cap.
- The skill stays at 204 lines (`TestEmberSkill` fails at 205): the opening paragraph
  was rewrapped, and step 5's "do not wait in a loop" sentence became a clause.

## Tests

- `TestPrefixAndSystemPrompt` checks for the last-text rule, the stand-alone reply,
  `view.inline` with /cf/theme.css, the pending-question clause and the explicit-ask
  exception. It fails if "Write nothing between tool calls" comes back, or if `soul.md`
  says again that Ember never edits files.
- `TestEmberSkill` checks for both last-text lines and the explicit-ask opening line,
  and fails if "You never edit files" comes back.

## Rollout

The rules are embedded in the daemon binary, so a daemon restart is needed. Ember's
running epoch keeps the old system prompt until its next epoch or `ember.reseed`.
