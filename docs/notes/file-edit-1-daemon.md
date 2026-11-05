# Editing a file: the daemon (PR 1 of 3)

`FilesystemService.WriteFile`, beside ReadFile: `fsx.Writer` does the work and the handler
only maps it. No GUI, command or CLI verb yet: PR 2 (GUI) and PR 3 (agent `--edit`) call it.

## Decisions

* **Reach.** Under home, symlinks resolved, like ReadFile, except a config home outside
  its worktrees and projects. The preview floor's credential list does not apply: `~/.ssh`,
  `~/.aws` and `~/.config` are what this feature is for.
* **The config home rule is `preview.Floor.InConfigHome`.** It shares the floor's home
  checks, so it decides by file identity (APFS folds names no string comparison sees:
  `cf-teſt` is `cf-test`), knows the default home as well as CODE_FOUNDRY_HOME, and finds
  other daemons' homes by their markers. fsx cannot import preview, so `Writer.Protected`
  carries it in. Pages are readable by a grant but count as the config home for a write.
* **A hard link to a config home file is not refused.** The rename replaces that name
  only; the token behind the other name is untouched.
* **Conflict is checked twice:** before anything touches the disk, and again with the temp
  file complete, just before the rename. `Writer.mu` makes check and write one step in the
  daemon, so of two saves from one baseline the second finds the first's file. Against
  other processes a gap of microseconds remains; rename has no compare-and-swap.
* **The result's size and time come from the temp file's descriptor,** not a stat of the
  name afterwards, which could report someone else's file and hide their change.
* **Create is a link(2) of the finished temp file,** not a rename: it fails on anything at
  the name, a dangling symlink included, so it is O_EXCL and atomic together. Force on a
  vanished file publishes the same way (mode 0600, the old mode is gone with the file), so
  a file that reappeared in that gap is a conflict even with force.
* **`create` with `force` is InvalidArgument.** One says never overwrite, the other always.
* **`not_found` joins `conflict`** so the GUI can say the file is gone rather than changed.
  A request without a baseline for an existing file is a conflict, not a write.
* **A symlink leading nowhere is never replaced.** No flag: conflict with not_found, as
  ReadFile sees it. `create`: the same, since something is there. `force`: InvalidArgument,
  because writing would drop the link and Overwrite could never succeed.
* **A directory is InvalidArgument under `create` too,** not a conflict: Overwrite could
  not resolve it.

## Gotchas

* The temp name is fixed (`.cf-write-*`), not built from the target's: a 255-byte name
  would otherwise fail with ENAMETOOLONG.
* Replacing by rename gives the file a new inode: other hard links keep the old contents,
  and extended attributes, ACLs and the birth time are not carried over.
* Rename needs write access to the directory, not the file, so a read-only (0444) file is
  replaced and stays 0444. A file the user does not own becomes theirs.
* EPERM is read as a privacy denial, as ReadFile does. A Finder-locked file or folder
  (`uchg`) also gives EPERM, so it gets the privacy advice, which will not help. Checked
  on a scratch daemon with `chflags uchg`.
* A filesystem without hard links fails a create. Home is APFS; this was not tried on a
  file provider folder such as `~/Library/CloudStorage`.
* A crash between the write and the rename leaves a `.cf-write-*` file, 0600 or the
  target's mode, holding the contents.
* Same size within the same millisecond is not seen as a change: the baseline is what
  ReadFile reports.
* The daemon does not know a read was truncated. PR 2 must not offer editing for a file
  ReadFile marked `truncated`: a save would drop the rest of it.

## Checked

Table tests in `internal/fsx`, `internal/preview` and `internal/api`. The race and failure
paths use `Writer.staged`, which runs with the temp file complete. A scratch dev daemon
(own HOME and CODE_FOUNDRY_HOME) took Connect JSON over curl for edit, stale edit, force
through a symlink, `~/.ssh`, create and create again, the token (directly, by symlink, in
capitals), the database, a checkout in the config home, a directory, outside home, and
both sides of the cap. No temp files stayed, and no contents reached the logs. A real TCC
denial was not produced; its path was only reached through `uchg`.
