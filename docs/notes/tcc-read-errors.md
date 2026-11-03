# File reads refused by macOS privacy (TCC)

Users reported that opening a file sometimes failed with
`fsx: read <path>: open <path>: operation not permitted`.

## Cause

`open(2)` returning EPERM (not EACCES, which file modes give) is macOS's privacy
protection (TCC). It guards the Desktop, Documents and Downloads folders, iCloud Drive,
`~/Library/CloudStorage`, and things only Full Disk Access opens: Mail, Messages,
Safari, the Trash, and other apps' containers. `lstat` gets through, which is why
`EvalSymlinks` and `Stat` in `fsx.ReadFile` succeed and only the `os.Open` fails.

TCC does not judge the daemon itself. It judges the daemon's *responsible* process,
which is inherited through fork/exec unless the parent disclaims it:

* Daemon auto-started by the CLI in a terminal: the terminal app. That is a stable,
  signed identity that usually already has folder access.
* Daemon auto-started by the production GUI: the GUI. Since dictation
  (`1fe96a82a`, `gui/responsible_darwin.go`), the GUI restarts itself as its own
  responsible process so the microphone prompt names Code Foundry. So the daemon, and
  every `claude`, git and shell it starts, is judged as "Code Foundry". That is an ad-hoc
  signed bare executable whose grants TCC keys to the cdhash, so **each release starts
  with no folder access**. The first read in a protected folder raises "Code Foundry
  would like to access files in your Documents folder" while the `open` blocks. If that
  prompt is denied, missed, or shown behind the window, the read fails with EPERM.
* Once the process a daemon inherited responsibility from exits (the terminal quit),
  the daemon resolves to itself (`code-foundry`, ad-hoc, no grants). That was checked
  here: a child spawned by a disclaimed parent reports the parent as responsible while
  the parent lives and itself after the parent exits.

"Sometimes" is that matrix: which folder, which build, which launcher, and whether the
launcher still runs.

## Change

* `internal/tcc`: `ResponsibleApp()` names the app macOS checks for this process
  (`responsibility_get_pid_responsible_for_pid`, weak-linked libSystem SPI already used by
  `gui/responsible_darwin.go`, plus `proc_pidpath`; outermost `.app` name, else the
  executable name). It is read on every call because responsibility drifts when the
  launcher exits. It is a stateless libSystem call, not one of the goroutine-owned cgo
  libraries.
* `fsx.ReadFile`: EPERM from `open` is an `ErrNotPermitted` error (it still unwraps to
  the `PathError`, so `fs.ErrPermission` matches). The message names the file, the app,
  and the area: "your Documents folder", iCloud Drive, "files managed by Dropbox", else
  Full Disk Access. It also says where to allow it.
* `api`: `ErrNotPermitted` is `PermissionDenied` (was `Internal`) for `ReadFile` and
  `PreviewFile`. The file tab already shows the daemon's message with Retry.
* `PreviewFile` on a refused file the preview guards anyway (`~/Library` holds iCloud Drive
  and cloud storage) gives the "protected folder" error, since allowing it would not help.
* EACCES (file modes) stays a plain error with no TCC advice. Directory completion already
  lists a refused directory as empty.

## Verified

Daemon from this branch in a scratch `CODE_FOUNDRY_HOME`, `ReadFile` over the socket on
`~/Library/Safari/Bookmarks.plist`, which only Full Disk Access opens, so no prompt:

* started from a shell under T3 Code: `permission_denied`, "\"T3 Code (Beta)\" needs Full
  Disk Access to read it. …"
* started disclaimed, so it answers for itself (as after its GUI quits): `permission_denied`, "\"code-foundry\"
  needs Full Disk Access …". `PreviewFile` gives the same.
* `~/.zshrc` still reads.

A daemon under the production GUI was not run: it should name "Code Foundry", which only
differs in the name. `stat` was checked inside the Full Disk Access folders (`~/Library/Mail`,
`Safari`, `Messages`): it gets through, so `os.Open` is the one call to classify.

## Grants that survive updates

`scripts/package.sh` signs the GUI and the CLI ad-hoc as `dev.alexwaumann.codefoundry`,
with an explicit designated requirement of that identifier in place of the default
cdhash. TCC stores a grant against the requirement, so a later build with the same
identifier should keep it.

They share one identity because the daemon outlives the GUI: once the GUI quits, the
daemon is judged as itself, and a second identity would have none of the grants given
while the GUI was responsible. Separate identities would protect nothing: under the GUI
the daemon already has the GUI's grants, and both are as forgeable. If TCC keys bare
executables by path rather than identifier, the two are simply asked separately. The dictation
engine stays on the default: TCC never checks it for a file read or the microphone. The
microphone grant is on the GUI, so it should stop being asked for after each update too.

Trade-offs:

* Any local program ad-hoc signed with this identifier meets the requirement
  and would get the same grants, as would a replaced executable in `~/.code-foundry/app`.
  The cdhash refused both. Accepted: a Developer ID signature is the real fix and we have
  none.
* A denial is stored the same way, so "Don't Allow" now also survives updates (it used to
  last until the next build). The way out is System Settings, which the error names.
* Existing grants are keyed to the old cdhash, so the first release with this asks once.
* `make gui-build` and `wails3 dev` are not re-signed: dev builds keep asking per build.

Checked on `make package` output: the tarball's GUI and CLI report their identifier and
requirement, the GUI's Info.plist is still bound (12 entries), and a CLI patched to another
version and signed the same way meets the first build's requirement while another
identifier's requirement fails. That run used a separate `.cli` identifier for the CLI;
the shared one was re-checked with `make package` afterwards.

**Not verified:** that tccd honours the requirement across two real builds, that a grant
given under the GUI holds for the daemon after the GUI quits, and that a managed Mac's MDM
accepts these signatures. All need a grant answered by hand on real releases. If tccd does not keep the grant, restore the "each update needs it again"
sentence in `fsx.privacyMessage`, which this change removed.

Options not taken: a helper process for the microphone so the daemon goes back to the
terminal's identity (still drifts when the terminal quits).
