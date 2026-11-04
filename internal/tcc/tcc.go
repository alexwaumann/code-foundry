// Package tcc names the app macOS's privacy protection (TCC) checks for this process.
//
// macOS decides whether a process may read the Desktop, Documents and Downloads
// folders, iCloud Drive, cloud storage or other apps' data by the process
// "responsible" for it, not by the process itself: for the daemon that is the GUI (which
// starts as its own responsible process, gui/responsible_darwin.go) or the terminal app
// the daemon was started from, and the daemon itself once that terminal has quit. An
// error that says "operation not permitted" is only actionable when it names that app.
package tcc

/*
#include <libproc.h>
#include <unistd.h>

// libSystem's private call (LLDB, Chromium and Qt use it too); weak, so its absence is
// "this process".
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid) __attribute__((weak_import));

// cfResponsiblePath writes the executable path of the process responsible for this one
// into buf. Returns its length, 0 when unknown.
static int cfResponsiblePath(char* buf, int size) {
	pid_t pid = getpid();
	if (responsibility_get_pid_responsible_for_pid != NULL) {
		pid_t r = responsibility_get_pid_responsible_for_pid(pid);
		if (r > 0) pid = r;
	}
	return proc_pidpath(pid, buf, (uint32_t)size);
}
*/
import "C"

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

// App is a process macOS checks, as System Settings → Privacy & Security lists it.
type App struct {
	// Name is an app bundle's name ("iTerm"), else the executable's file name.
	Name string
	// Path is its executable.
	Path string
	// Bundled says it is inside an app bundle. Only a bundle gets folder toggles that
	// can be relied on: an entry for a bare executable keeps the signature of the build
	// that made it, and has to be removed and added again (docs/notes/tcc-read-errors.md).
	Bundled bool
}

// Responsible is the process responsible for this one. It is read on each call: the
// responsible process changes when the one that started the daemon exits.
func Responsible() App {
	buf := make([]byte, C.PROC_PIDPATHINFO_MAXSIZE)
	n := C.cfResponsiblePath((*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf)))
	if n > 0 {
		return appAt(string(buf[:n]))
	}
	exe, err := os.Executable()
	if err != nil {
		return App{Name: "code-foundry"}
	}
	return appAt(exe)
}

// appAt is the App of the executable at exe: the outermost app bundle holding it, without
// ".app", else the bare executable.
func appAt(exe string) App {
	for _, p := range strings.Split(filepath.Clean(exe), "/") {
		if name, ok := strings.CutSuffix(p, ".app"); ok && name != "" {
			return App{Name: name, Path: exe, Bundled: true}
		}
	}
	return App{Name: filepath.Base(exe), Path: exe}
}
