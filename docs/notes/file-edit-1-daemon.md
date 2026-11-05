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
* **A checkout is what lies strictly below `worktrees` or `projects`.** Those folders do
  not exist until first use, and a file made at their name breaks every later clone, so
  `InConfigHome` asks about p's directory as well as p: a name directly in a config home
  is always the config home's. `Guarded` and `ScopeOK` are unchanged.
* **Only the resolved path counts.** A rooted workspace's `CLAUDE.md` is a symlink in
  `~/.code-foundry/workspaces/<id>` to a file outside the config home, and saving it must
  work. A symlink outside leading into the config home stays refused.
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
* **A symlink leading nowhere is never replaced,** and a loop counts as one. No flag:
  conflict with not_found, as ReadFile sees it. `create`: the same, since something is
  there. `force`: InvalidArgument, because writing would drop the link and Overwrite could
  never succeed. EvalSymlinks has no error to tell a loop by, so a stat asks the kernel.
* **A directory is InvalidArgument under `create` too,** not a conflict: Overwrite could
  not resolve it.
* **A file with no owner write bit is refused, even with force** (FailedPrecondition, says
  read-only). Rename needs only the directory, so it would replace the file without a
  word, where every editor says read-only. It comes ahead of a stale baseline, which
  Overwrite could not get past; `create` still gets its conflict.
* **The group stays, set before any contents go in.** A replaced file otherwise takes its
  directory's group: a 0640 secret in `admin` became 0640 in `staff`, a wider audience with
  the mode unchanged. If the user cannot give that group, the group's access goes instead.
* **Setuid, setgid and sticky stay.** The permission bits go on before the contents, the
  special bits after them, because the kernel clears setuid and setgid on a write.
* **Errors say what to do.** FailedPrecondition (`ErrNotWritable`): read-only file, locked
  file or folder, EACCES or EROFS on the folder. ResourceExhausted (`ErrDiskFull`): ENOSPC
  and EDQUOT. InvalidArgument: a name too long, a NUL. PermissionDenied stays macOS's
  privacy protection alone. Messages are worded from the errno, so none names the temp file.
* **A Finder-locked file is told apart by `st_flags`.** It gives the EPERM a privacy denial
  gives, so on EPERM the file and its folder are checked for `uchg` and its relations
  (`locked_darwin.go`; elsewhere `locked` is false, since `Stat_t` has no flags there).

## Gotchas

* The temp name is fixed (`.cf-write-*`), not built from the target's: a 255-byte name
  would otherwise fail with ENAMETOOLONG.
* Replacing by rename gives the file a new inode: other hard links keep the old contents,
  and extended attributes, ACLs and the birth time are not carried over. **This can widen
  access:** a deny ACL on the old file is gone after a save. A file the user does not own
  becomes theirs.
* Any other EPERM still reads as a privacy denial, as in ReadFile.
* A filesystem without hard links fails a create. Home is APFS; this was not tried on a
  file provider folder such as `~/Library/CloudStorage`.
* Same size within the same millisecond is not seen as a change: the baseline is what
  ReadFile reports.
* The daemon does not know a read was truncated. PR 2 must not offer editing for a file
  ReadFile marked `truncated`: a save would drop the rest of it.

## Known limits

* The gap between the checks and the write can be raced by a process of the same user, by
  swapping a parent directory for a symlink, say. That process could write there anyway, so
  no boundary is crossed.
* A SIGKILL or crash during staging leaves a `.cf-write-*` file beside the target, holding
  the contents, with the target's mode (0600 for a new file). Nothing cleans it up, and it
  is not gitignored, so in a checkout it shows as untracked and could be committed.

## Checked

Table tests in `internal/fsx`, `internal/preview` and `internal/api`. The race and failure
paths use `Writer.staged`; `Writer.filling` looks at the temp file just before contents
go in, which fails on a wider temp or a write before the chmod (both tried). A scratch dev
daemon (own HOME and CODE_FOUNDRY_HOME) took Connect JSON over curl for edit, stale edit,
force through a symlink, `~/.ssh`, create and create again, the token (directly, by
symlink, in capitals), the database, a checkout in the config home, a rooted workspace's
link, the open roots, a directory, outside home, both sides of the cap, a kept group,
setuid, a read-only file, locked file and folder, a closed folder, a loop, a NUL and a long
name. No temp files stayed, and no contents reached the logs. ENOSPC, EROFS and a real TCC
denial were not produced: their mapping is tested on the errno alone.
