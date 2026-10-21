# thread wait settles by default

## Problem

A lead that waited on a child with `thread wait <child>` (or `thread send ... --wait`)
blocked for the whole `--for` while the child sat at a permission prompt or a question.
The default `--until` was `idle`, and idle (`thread.Meets(CondIdle)`, `idleNow`) leaves a
pending prompt out on purpose. The timeout error named the prompt, but only after, say,
30 minutes. `--notify` wakes (settled: idle or attention) did return at a prompt, so a
wait and a wake disagreed about what "the child stopped" means, and the orchestrate skill
told leads that a wait "blocks until the thread stops working".

## Decisions

- New wait condition `settled` (`THREAD_WAIT_CONDITION_SETTLED`, `thread.CondSettled`:
  idle or attention), the default for `thread wait --until` and for `thread send --wait`.
  `idle`, `attention`, `error` and `disconnected` stay as opt-ins. `idleNow` and
  `Meets(CondIdle)` are unchanged: the idle wake, the lead hold and the waiting status
  share them.
- `THREAD_WAIT_CONDITION_UNSPECIFIED` now means SETTLED. The CLI is the only caller and
  GUI, CLI and daemon always ship as one version, so no old caller relies on IDLE.
- When the wait returns at a pending request, the status line stays as it was (scripts
  read it), and one line per pending request follows, oldest first:

      pending permission <request>: <Tool> <input JSON, compacted>; answer with: code-foundry thread respond --id <id> allow (or deny --message "why")
      pending question <request>: <question> (options: A | B); answer with: code-foundry thread respond --id <id> --answer "<label>"

  With more than one pending request each line adds `--request <id>`; a request with
  several questions shows them joined with ` / ` and the answer as the JSON object
  `parseAnswers` takes. The data comes from `ThreadService.ListItems` (the snapshot's
  `pending` plus the request item's `input_json`), the RPC `thread respond` already
  uses: no new RPC. It is read only when the returned thread is connected and needs
  attention for a `permission:` or `question:` reason. A tool input over 600 bytes is cut
  with a marker pointing at `thread read --full`.
- `--json` still prints the thread alone. A `pending` field would have meant wrapping
  the proto in a new shape; the text lines cover the lead's need.

## Gotcha: the answered request's stale status

The runner publishes a thread's status after a 100 ms debounce (`StatusDebounce`). For
that moment after an answer the thread still reads "needs attention (permission: …)".
With `settled` as the default, `thread wait` right after `thread respond` met the
condition at once: the default `--after` (the latest message) counts the permission item
itself as Claude's reaction (`isReaction`), and the stale status meets settled. So the
wait returned on the request just answered.

Fix in `ThreadService.Wait` (`answeredRequest`): a connected thread's `permission:` or
`question:` status counts only while a request is still pending in its items. Pending
requests are dropped from the items the moment the answer is applied, ahead of the
status publish, so the wait keeps listening and returns on the next real state (the
following prompt, or the turn's end). A stopped thread keeps its request status with
nothing pending (it says what it waited on); that one still counts, or a wait on it
would hang. `thread respond`'s own 500 ms settle wait mostly hid this from CLI callers;
the guard makes it hold without relying on it. `TestThreadWaitAfterAnswer` fails without
the guard. The fake store's `AppendItem` now updates the pending requests the way
`PutItems` and `Respond` do.

## Docs

The orchestrate skill's step 2 and `reference/patterns.md` §1 and §4 say a wait returns
when the child finishes, fails or asks something, and to answer with the printed
`thread respond` line and wait again. SKILL.md stays at its 136-line cap (the wake
paragraph was reflowed to pay for the extra line). The guide's "Do not poll" convention
says the same; the guide is about 24 KB of its 29 KB cap. The ember skill uses only
`--notify` and is unchanged.

## Live check

Real daemon on an isolated home (`CODE_FOUNDRY_HOME=/tmp/cf-wait-settled`), scratch repo,
a supervised child on `claude-haiku-5-5[1m]` at medium effort, prompt "Use the Bash tool
to run touch hello.txt, then reply done":

    $ code-foundry thread wait s-4ae6534ddabc --for 60s
    thread s-4ae6534ddabc child: needs attention (permission: Bash Create empty hello.txt in working directory)
    pending permission c61b036d-82cf-48b1-862e-2a2c42df14d7: Bash {"command":"touch hello.txt","description":"Create empty hello.txt in working directory"}; answer with: code-foundry thread respond --id s-4ae6534ddabc allow (or deny --message "why")
    exit 0 after 0s
    $ code-foundry thread respond --id s-4ae6534ddabc allow
    Bash Create empty hello.txt in working directory: allowed (allow); nothing pending
    $ code-foundry thread wait s-4ae6534ddabc
    thread s-4ae6534ddabc child: needs attention (finished)
    exit 0 after 1s
    $ code-foundry thread send --id s-4ae6534ddabc "Use the Bash tool to run rm hello.txt, then reply done" --wait --for 60s
    thread s-4ae6534ddabc child: needs attention (permission: Bash Remove hello.txt from working directory)
    pending permission 191dd551-b5b2-40fd-8d7f-770a459dc300: Bash {"command":"rm hello.txt","description":"Remove hello.txt from working directory"}; answer with: code-foundry thread respond --id s-4ae6534ddabc allow (or deny --message "why")
    exit 0 after 2s
    $ code-foundry thread respond --id s-4ae6534ddabc deny --message "keep it"
    Bash Remove hello.txt from working directory: denied (deny): keep it; nothing pending
    $ code-foundry thread wait s-4ae6534ddabc
    thread s-4ae6534ddabc child: needs attention (finished)
    $ code-foundry thread send --id s-4ae6534ddabc "Use the AskUserQuestion tool to ask me which color to use, options Red and Blue, then reply with my choice" --wait --for 60s
    thread s-4ae6534ddabc child: needs attention (question: Which color would you like to use?)
    pending question 54daea37-a612-4d62-a63b-cfdbd841f487: Which color would you like to use? (options: Red | Blue); answer with: code-foundry thread respond --id s-4ae6534ddabc --answer "<label>"
    exit 0 after 1s
    $ code-foundry thread respond --id s-4ae6534ddabc --answer Blue
    answered "Which color would you like to use?": Blue; nothing pending
    $ code-foundry thread wait s-4ae6534ddabc
    thread s-4ae6534ddabc child: needs attention (finished)

## Left out

- A `pending` field in `--json` (see above).
- The timeout message for an explicit `--until idle` at a prompt is unchanged: it names
  the status, not the pending lines.
- Wake subscriptions have the same 100 ms stale-status window after an answer; their
  edge trigger (a new request id, `firesOnRequest`) already keeps them from firing again
  on an answered request, so they were not touched.
