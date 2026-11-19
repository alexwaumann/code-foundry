# Page path identity

Fixes from the page fuzz pass about how the daemon tells which page file a path names, and
what the page-showing verbs accept and say.

## What was wrong

- One file under two spellings was two pages. APFS ignores letter case and Unicode
  normalisation, and `filepath.EvalSymlinks` keeps whichever spelling it is given, so
  `~/Case/Report.html` and `~/case/report.html`, or a folder Finder named NFD (`Résumé/`)
  and the NFC spelling Claude types, keyed two owners, two answers and two storage
  directories. A thread wrote the page under one spelling and the file tree opened it as
  "no owner, not asked" under the other; "Stop allowing" under one left it allowed under
  the other.
- `page.allow` / `page.disallow` refused only `Origin = PAGE`, not a caller that named
  neither origin nor view (`OriginUnknown`, what `page-verb-gate.md` treats as a page).
- `PreviewFile` answered `internal` for a path over PATH_MAX.
- `view.inline`'s refusals said what was wrong but not what to do instead.
- With `CODE_FOUNDRY_HOME` outside home (a side-by-side install, every dev drive under
  `/tmp`), a thread could not show its own `$CODE_FOUNDRY_PAGES` page with `view.inline` or
  `view.open.page`, although the page store owns it.
- The same file through a symlink (or another case) got a second live card.
- A no-project thread (cwd = home) stored a page as a bare relative path, so the CLI and
  the card showed `cf-pages/x.html` where a project thread shows `~/cf-pages/x.html`.

## The rule now

- A page is keyed by its absolute path with symlinks resolved and **spelled as on disk**:
  `fsx.OnDiskPath` lists each parent directory and takes the listed name that is the same
  file (`os.SameFile`) and equal but for case and normalisation. A name listed exactly is
  kept, so a case-sensitive volume's `Plan.html` and `plan.html` stay two pages. A hard
  link's other name stays its own key: it is the same inode, not the same name.
- Rows and storage kept under another spelling (by a daemon from before this change) are
  found at read time, not migrated: `keys` asks SQLite for rows whose path matches
  `fsx.LikeSpellings` (the ASCII prefix up to the first non-ASCII character, `LIKE` being
  ASCII case-insensitive) and keeps those `fsx.OtherSpelling` confirms are the same file.
  The newest row wins, the on-disk key first among equals.
- An answer or an owner is written to the on-disk key **and** every other key of the same
  file, in one transaction, so a revoke sticks whichever row a later read finds first,
  whatever the clock does.
- Storage under another spelling is used where it is (its `path` file keeps that key, so
  Sweep keeps it while the file exists); a second directory under the on-disk key is never
  started beside it. Several such directories: the newest written.
- A case-only rename keeps the answer and storage: the old key is another spelling of the
  renamed file.
- `page.allow` / `page.disallow` refuse any `Context.Untrusted` caller. The GUI always
  sends a view, so its own controls are unaffected.
- `fileError` maps `ENAMETOOLONG` to `InvalidArgument` (ReadFile and PreviewFile).
- `view.inline` takes a file under home or the pages root, as the page store does; its
  refusals name `$CODE_FOUNDRY_PAGES` and `view.open.file`. `view.open.page` takes the
  pages root too (`ViewDeps.PagesRoot`). The app's worktrees root under an outside
  `CODE_FOUNDRY_HOME` is still not a page place: the page store does not own it either.
- `shownHTML` takes an older card as the same page when its path is the same file
  (`os.SameFile` after following links), so a symlink or another case reuses the card.
- An html item whose cwd is home is stored absolute (the GUI shows it as `~/…`); the mock
  does the same.

## Gotchas

- `fcntl(F_GETPATH)` gave the on-disk spelling in a quick try, but it answers from the
  kernel's name cache, which is not documented to hold the stored spelling, and calling
  it from Go needs a raw syscall. Listing the directory answers from the volume itself
  and is plain Go.
- `OnDiskPath` lists every ancestor directory on each call. Pages are opened by hand, so
  that cost is fine; do not call it in a loop over many files.
- A card re-shown with `--again` under another spelling is a new card under that spelling,
  so the GUI's "shown again below" link (keyed by path) does not join the two. Rare.
- Tests that need a case- and normalisation-insensitive volume use
  `fsxtest.NeedInsensitive` / `fsxtest.Insensitive`, which probe the temp folder.
