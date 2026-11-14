# Verbs pages use

{{cf.provenance}}

For the code-foundry-pages skill: the verbs pages call most, as `cf.run(verb, {arg: value})`.
A starter list: every verb the CLI runs works the same way (`memory.add`, `view.open.url`…).
Args by name, values after them in plain text; `code-foundry help <verb>` has the rest.

| Verb | Args |
|---|---|
| `pr.merge` (asks first) | `repo-slug`, `number`, `method` merge, squash or rebase, `head-sha` the PR's `headSha` |
| `pr.auto-merge` (asks first) | `repo-slug`, `number`, `method` merge, squash or rebase, or `off` true |
| `pr.ready`, `pr.draft` (no dialog) | `repo-slug`, `number` |
| `pr.checks` (read) | `repo-slug`, `number`; watch one PR: run it again in `cf.on("gh", …)` |
| `thread.archive` (asks when busy) | `id`; `archived` false unarchives |
| `thread.snooze` | `id`, `until` 1h, 3h, tomorrow, next-week, mon…sun or a date; or `save` true (no wake); or `clear` true |
| `thread.pin`, `thread.send` | `id`; `pinned` true or false; `text` the message |
| `thread.new` | `prompt`, `name`, `project` id, `new-worktree` true, `created-by` "" for a thread of the user's own |
| `settings.get` (read), `settings.set` (shows the user a dialog; user-only settings refused) | `key`; `value` as a string |
| `usage.show` (read) | `thread` an id, or `all` true |
| `composer.stage` | `text` goes in the composer for the user to send (never sent); `thread` defaults to this one |
| `project.add` | no args opens the Add Project dialog; `path` adds a folder without it (shows the user a dialog) |
| `view.open.page` | `path` an .html page opens as a tab beside this thread only (no card), with this bridge; `title` names its tab |
| `view.settings` | `page` general, appearance, memory, plugins, skills…; an unknown one lists them |
| `theme.reset` | `slot` dark or light (default: the one in use) back to the default theme; the user's themes stay |
| `file.export` (asks first) | `path` a file name, or a path in this thread's checkout to a folder that exists (no name starting with a dot); `text`, or `base64` for bytes; at most 256 KiB; replacing a file asks again |

A page cannot download: an Export button saves into this thread's checkout, and the result's
`json.path` says where. Build the contents in the handler and show the path:

```js
exportButton.addEventListener("click", async () => {
  const csv = rows.map((r) => [r.id, r.name].join(",")).join("\n");
  try {
    const r = await cf.run("file.export", { path: "rows.csv", text: csv });
    status.textContent = "Saved to " + r.json.path;
  } catch (e) {
    status.textContent = e.code === "declined" ? "Not saved" : e.message;
  }
});
```
