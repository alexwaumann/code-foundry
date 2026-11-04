package fsx

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/alexwaumann/code-foundry/internal/tcc"
)

// ErrNotPermitted matches ReadFile's error for a file macOS's privacy protection (TCC)
// would not let the daemon open: EPERM from open(2), which plain file modes never give
// (they give EACCES). See docs/notes/tcc-read-errors.md.
var ErrNotPermitted = errors.New("not permitted")

// notPermittedError says which app macOS checked and where to allow it.
type notPermittedError struct {
	msg string
	err error // the open error
}

func (e *notPermittedError) Error() string        { return e.msg }
func (e *notPermittedError) Unwrap() error        { return e.err }
func (e *notPermittedError) Is(target error) bool { return target == ErrNotPermitted }

// isPrivacyDenial reports whether err from opening a file is macOS refusing it.
func isPrivacyDenial(err error) bool { return errors.Is(err, syscall.EPERM) }

// notPermitted is ReadFile's error for path (as asked) whose file real (symlinks
// resolved, under root) macOS would not open, naming the app it checked.
func notPermitted(root, path, real string, err error) error {
	return &notPermittedError{msg: privacyMessage(root, path, real, tcc.Responsible()), err: err}
}

// restartDaemon is the last step of every fix: quitting the app leaves the daemon
// running, and it is the process that was refused.
const restartDaemon = "run Restart Daemon from the command palette"

// privacyMessage explains a privacy denial of path (real once resolved, under root) to
// app, the process macOS checked. A bundled app has its toggles in Files and Folders. A
// bare executable, ours included, goes through Full Disk Access, and an entry made by
// another build does nothing until it is removed and added again.
func privacyMessage(root, path, real string, app tcc.App) string {
	var b strings.Builder
	fmt.Fprintf(&b, "macOS's privacy protection blocked reading %s: ", path)
	what := protectedArea(root, real)
	if what != "" {
		fmt.Fprintf(&b, "%q has no access to %s. ", app.Name, what)
	} else {
		fmt.Fprintf(&b, "%q needs Full Disk Access to read it. ", app.Name)
	}
	switch {
	case !app.Bundled:
		fmt.Fprintf(&b, "In System Settings → Privacy & Security → Full Disk Access, select %q and click − if it is listed, even if it is on. Then click +, press ⌘⇧G, enter %s, turn it on, and %s.",
			app.Name, homePath(root, app.Path), restartDaemon)
	case what != "":
		fmt.Fprintf(&b, "Allow it in System Settings → Privacy & Security → Files and Folders (or Full Disk Access), then %s.", restartDaemon)
	default:
		fmt.Fprintf(&b, "Allow it in System Settings → Privacy & Security → Full Disk Access, then %s.", restartDaemon)
	}
	return b.String()
}

// homePath is p with root, the home directory, written as "~".
func homePath(root, p string) string {
	if Within(root, p) {
		return "~" + p[len(root):]
	}
	return p
}

// protectedArea names the Files and Folders entry that covers real (a resolved path
// under root, the home directory), or "" for a file only Full Disk Access opens (Mail,
// Messages, Safari, the Trash, other apps' containers).
func protectedArea(root, real string) string {
	rel, err := filepath.Rel(root, real)
	if err != nil || !Within(root, real) {
		return ""
	}
	parts := strings.Split(filepath.ToSlash(rel), "/")
	at := func(i int, name string) bool { return len(parts) > i && strings.EqualFold(parts[i], name) }
	switch {
	case at(0, "Desktop"):
		return "your Desktop folder"
	case at(0, "Documents"):
		return "your Documents folder"
	case at(0, "Downloads"):
		return "your Downloads folder"
	case at(0, "Library") && at(1, "Mobile Documents"):
		return "iCloud Drive"
	case at(0, "Library") && at(1, "CloudStorage") && len(parts) > 2:
		return "files managed by " + cloudProvider(parts[2])
	}
	return ""
}

// cloudProvider is the provider of a ~/Library/CloudStorage directory
// ("GoogleDrive-me@example.com" → "GoogleDrive", "Dropbox" → "Dropbox").
func cloudProvider(dir string) string {
	name, _, _ := strings.Cut(dir, "-")
	return name
}
