# A page saves a file: file.export (2026-11-10)

A page runs in a sandboxed frame with no download handler, so an Export button made a file
that went nowhere, reported only in the page's error badge (`page-frame-links.md`, "Downloads
are reported, not built"). The owner chose a bridge verb that saves into the thread's checkout.

## What shipped

- **`file.export <path> (--text | --base64) [--thread]`** (`internal/command/commands_file_export.go`)
  writes into the thread's checkout, its `worktree_path` (its cwd), and answers
  `{path, size, replaced}` with the absolute path. NoPalette, NoKeybinding, NoIndex: it is for
  pages, and a model has its own Write tool. Category View, as the other `file.*` verbs.
- **The writer is the File tab's.** `fsx.WriteRequest.Within` keeps a write under a directory,
  symlinks resolved on both sides, and `Writer.Lookup` says what a write would find without
  writing. `Filesystem.ExportTarget` and `ExportFile` (`internal/api/filesystem_export.go`) use
  the Filesystem's own Writer, so its Protected rule (the config home) and its lock hold.
- **The page side**: `UNSUPPORTED.download` (`previewGrant.ts`) now tells the author to call
  `cf.run("file.export", { path, text })` from the click and show the path. The pages skill's
  `verbs.md` has the row and a short Export example; `errors-and-limits.md` says the same;
  SKILL.md's "asks the user" line names saving a file.
- **The mock** (`mock/fileExport.ts`) has the same command, refusals, questions and labels,
  writing into its fake disk. The mock's `confirmLabel` may now be a function, so a page's
  question says Allow and a replace says Replace, as the daemon's do.

## Decisions

- **It asks a page every time (PageRuns).** It writes outside the app's state, which is what
  `page-verb-gate.md` asks about. The question is the call plus "Saves 1.2 KiB to <absolute
  path>" (`PageDetail`), so the user sees where it lands.
- **The contents show as their size.** A page's question refuses a call over 800 characters,
  and a CSV is longer. `ArgSpec.PageShowsSize` prints `--text <2.9 KiB>` in the question
  instead. The user agrees to a file name, a place and a size, as with a browser's download.
- **Replacing is the command's Confirm**, asked only when a file is there (`ConfirmIf`), naming
  the absolute path and both sizes, with Replace on the button. It is the one question a page
  gets for that call. The yes is bound (`BindConfirm` `replaces` = size:mtime of the file
  named), and the write uses that as the writer's baseline: a file changed since the question
  is not replaced ("changed since you were asked").
- **A page's yes to "Run this?" only makes a file.** A file that appears between the question
  and the yes is refused ("exists now"), never replaced unasked. The CLI's `--yes` (a trusted
  caller, confirmed, no binding) replaces whatever is there.
- **Paths**: relative only (`filepath.IsLocal`: no absolute path, no `~`, no `..` out of the
  checkout), into a folder that exists (the writer makes no folders, and a second writer was
  out), never the checkout itself or a directory. Symlinks are followed and must stay inside
  (`Within`).
- **No name may start with a dot.** `.git/config`, `.claude/settings.json`, `.vscode/tasks.json`
  and a shell's `.zshrc` are where programs read what to run; a page's data has no business
  there, and a question is only as good as its reading. The rule is on the path as given.
- **A thread without a project** saves into its cwd, the home folder, as every thread-scoped
  file verb resolves it. There the dot rule keeps out `~/.ssh` and the config home, and the
  preview's guarded folders (`Grants.Guarded`: credentials, `~/Library`, the config home) are
  refused too, so a page cannot drop a LaunchAgent. A thread with no `worktree_path` yet is
  refused "has no checkout yet", as `terminal.new` refuses it.
- **256 KiB** of file, decoded: the bridge's cap on a call (`BRIDGE_LIMITS.messageChars`), so a
  page never makes a file the CLI could not. `bridge.js` already rejects a larger call, so
  through the bridge base64 carries at most about 192 KiB of bytes. The daemon's limit is the
  same from the CLI (`--text @file`).
- **`--text` or `--base64`, exactly one.** Empty text is a valid, empty file (`Args.Blank`).
- **New files are 0600**, the writer's rule (a file may be a secret). Git tracks only the
  executable bit, so a committed export is unaffected.
- **No toast.** The bridge host answers a page's run to the page only; it has no pattern for
  showing a command's result to the user. The path comes back in the result, and the
  example shows it in the page.

## Gotchas

- The daemon's socket path has to fit macOS's 103 bytes: a scratch home under the session's
  scratchpad is too long, so the end-to-end run used a short `/tmp` folder, as `drive.sh` does.
- A page's `text: ""` arrives blank, which `Args.Given` does not count: check `Blank` too.
- One more row on `mock/bridge-page.html` made the card taller, and "a card that shrinks under
  the pointer" measures it. The Export button shares the thread.list row instead.

## Verified

- Go: `fsx` `TestWriteWithin`/`TestLookupBaseline`; `commands_file_export_test.go` over the
  real `api.Filesystem` in a scratch home: paths accepted and refused (symlinks in and out,
  the config home, dot names, a missing folder, home for a no-project thread, `~/Library`),
  contents (text, empty, base64, the cap in text and bytes), the replace question and its
  binding, a page's question, a file that appears after it, and a thread with no checkout.
- Vitest: the frame's download message; the mock's command (`mock/fileExport.test.ts`).
- Playwright: `e2e/bridge.spec.ts` "a page's Export button saves…": a click in the page's
  frame, the guarded question with the path, Allow, the path shown in the page, the file in
  the mock's disk, the call recorded unconfirmed then confirmed.
- A `--dev` daemon on a scratch `HOME` and `CODE_FOUNDRY_HOME` with `cmd/fakeclaude` as
  `claude`: a page file in a scratch project, then `file export` as that thread
  (`CODE_FOUNDRY_THREAD`): `rows.csv` written with `--text @file`; a second call printed
  "Replace <path>? A file is there already (20 bytes); it becomes 7 bytes." and exit 2 without
  a terminal; `--yes` replaced it; `--base64` into a subfolder; `../`, an absolute path,
  `.git/config`, a missing folder, a symlink to home and 256 KiB + 1 refused. A no-project
  thread saved into home and was refused `Library/LaunchAgents`, `.zshrc` and the config
  home. `CommandService.Invoke` with the page origin answered "Run this?" for a new file
  (label Allow) and the Replace question with its `replaces` binding.

## Compatibility

- Needs a daemon restart.
- New GUI, old daemon: the badge points at a verb the daemon does not have yet; a page's call
  answers `unavailable` until the restart.
- No on-disk change.
