package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>
#include <spawn.h>
#include <stdlib.h>
#include <unistd.h>

// macOS asks for the microphone on behalf of the "responsible" process: for a bare
// executable started from a terminal (code-foundry gui), that is the terminal app, so
// the prompt would name it and the grant would go to it. Starting the GUI again with
// responsibility disclaimed makes it its own responsible process, and TCC then uses its
// embedded Info.plist (NSMicrophoneUsageDescription). These are libSystem's private
// calls that LLDB, Chromium and Qt use for the same; weak, so their absence is "no".
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t* attrs, int disclaim) __attribute__((weak_import));
extern pid_t responsibility_get_pid_responsible_for_pid(pid_t pid) __attribute__((weak_import));

// cfNeedsDisclaim: another process is responsible for this one, and this executable
// carries its own microphone usage description (production builds embed it; dev builds
// do not, and without one TCC would kill a process that is its own responsible).
static int cfNeedsDisclaim(void) {
	if (responsibility_get_pid_responsible_for_pid == NULL || responsibility_spawnattrs_setdisclaim == NULL) return 0;
	pid_t self = getpid();
	if (responsibility_get_pid_responsible_for_pid(self) == self) return 0;
	@autoreleasepool {
		return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"] != nil;
	}
}

// cfSpawnDisclaimed starts path with argv and envp as its own responsible process,
// inheriting stdio. Returns posix_spawn's error (0 on success).
static int cfSpawnDisclaimed(const char* path, char** argv, char** envp) {
	posix_spawnattr_t attrs;
	int rc = posix_spawnattr_init(&attrs);
	if (rc != 0) return rc;
	rc = responsibility_spawnattrs_setdisclaim(&attrs, 1);
	if (rc == 0) {
		pid_t pid;
		rc = posix_spawn(&pid, path, NULL, &attrs, argv, envp);
	}
	posix_spawnattr_destroy(&attrs);
	return rc;
}
*/
import "C"

import (
	"log/slog"
	"os"
	"syscall"
	"unsafe"
)

// envDisclaimed marks the process respawnDisclaimed started, so it never respawns again.
const envDisclaimed = "CODE_FOUNDRY_GUI_DISCLAIMED"

// respawnDisclaimed starts this executable again as its own responsible process when
// it is not one, so the microphone prompt names Code Foundry rather than the terminal it
// was started from (docs/notes/dictation-3-host.md). It reports whether it did: the
// caller then exits. Called first thing in main, before any window or goroutine.
func respawnDisclaimed(log *slog.Logger) bool {
	if os.Getenv(envDisclaimed) != "" {
		_ = os.Unsetenv(envDisclaimed) // the daemon and its threads inherit the environment
		return false
	}
	if C.cfNeedsDisclaim() == 0 {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		log.Warn("respawn as responsible process", "err", err)
		return false
	}
	argv := cStrings(os.Args)
	defer freeCStrings(argv)
	envp := cStrings(append(os.Environ(), envDisclaimed+"=1"))
	defer freeCStrings(envp)
	path := C.CString(exe)
	defer C.free(unsafe.Pointer(path))
	if rc := C.cfSpawnDisclaimed(path, &argv[0], &envp[0]); rc != 0 {
		log.Warn("respawn as responsible process", "err", syscall.Errno(rc))
		return false
	}
	log.Debug("respawned as its own responsible process")
	return true
}

// cStrings is a NULL-terminated array of C copies of ss.
func cStrings(ss []string) []*C.char {
	out := make([]*C.char, len(ss)+1)
	for i, s := range ss {
		out[i] = C.CString(s)
	}
	return out
}

func freeCStrings(cs []*C.char) {
	for _, c := range cs {
		if c != nil {
			C.free(unsafe.Pointer(c))
		}
	}
}
