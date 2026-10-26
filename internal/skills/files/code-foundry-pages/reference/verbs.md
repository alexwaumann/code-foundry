# Verbs pages use

{{cf.provenance}}

For the code-foundry-pages skill: the verbs pages call most, as `cf.run(verb, {arg: value})`.
A starter list: every verb the CLI runs works the same way (`memory.add`, `view.open.url`…).
Args by name, values after them in plain text; `code-foundry help <verb>` has the rest.

| Verb | Args |
|---|---|
| `pr.merge` (asks first) | `repo-slug`, `number`, `method` merge, squash or rebase, `head-sha` the PR's `headSha` |
| `pr.checks` (read) | `repo-slug`, `number`; watch one PR: run it again in `cf.on("gh", …)` |
| `thread.archive` (asks when busy) | `id`; `archived` false unarchives |
| `thread.snooze` | `id`, `until` 1h, 3h, tomorrow, next-week, mon…sun or a date; or `clear` true |
| `thread.pin`, `thread.send` | `id`; `pinned` true or false; `text` the message |
| `thread.new` | `prompt`, `name`, `project` id, `new-worktree` true, `sidebar` true |
| `settings.get` (read), `settings.set` | `key`; `value` as a string |
| `usage.show` (read) | `thread` an id, or `all` true |
