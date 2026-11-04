package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework ApplicationServices -framework CoreFoundation
#include <ApplicationServices/ApplicationServices.h>

// The checks. None of these prompts, except cfAXPrompt, which is what it is for.
static int cfAXTrusted(void) { return AXIsProcessTrusted() ? 1 : 0; }
static int cfListenAccess(void) { return CGPreflightListenEventAccess() ? 1 : 0; }
static int cfPostAccess(void) { return CGPreflightPostEventAccess() ? 1 : 0; }

// cfAXPrompt asks for Accessibility, which also adds this executable to the list.
static int cfAXPrompt(void) {
	const void* keys[] = {kAXTrustedCheckOptionPrompt};
	const void* values[] = {kCFBooleanTrue};
	CFDictionaryRef options = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	Boolean trusted = AXIsProcessTrustedWithOptions(options);
	CFRelease(options);
	return trusted ? 1 : 0;
}

// cfTurnMainRunLoop handles what is pending on the main run loop and returns at once.
static void cfTurnMainRunLoop(void) {
	CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0, false);
}
*/
import "C"

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/version"
)

// The temporary probe for a system-wide "hold Alt, speak, paste" (docs/notes/accessibility-probe.md).
// To remove it: delete this file and its test, the check in main.go, and responsiblePid and
// the spawnDisclaimed split in responsible_darwin.go. althold*.go and paste*.go are meant to
// stay for the feature.

// probeLimit is how long the probe watches before it exits by itself.
const probeLimit = 3 * time.Minute

// accessibilityProbeArgs reports whether args ask for the probe, and for its prompt.
// Anything else falls through to main's refusal.
func accessibilityProbeArgs(args []string) (probe, prompt bool) {
	if len(args) == 0 || args[0] != "--accessibility-probe" {
		return false, false
	}
	switch {
	case len(args) == 1:
		return true, false
	case len(args) == 2 && args[1] == "--prompt":
		return true, true
	}
	return false, false
}

// accessibilityListName is where System Settings keeps the Accessibility grants, by the
// macOS version ("27.0.1"). macOS 27 renamed the list.
func accessibilityListName(osVersion string) string {
	major, _, _ := strings.Cut(osVersion, ".")
	if n, err := strconv.Atoi(major); err == nil && n >= 27 {
		return "Device Control and Data Access"
	}
	return "Accessibility"
}

// tapDecision says whether to create the tap, and what to print about it. Creating it
// while Input Monitoring is undecided may bring up macOS's prompt, so without --prompt
// it needs a grant to stand on. With Accessibility alone it goes ahead: whether that is
// enough for a listen-only tap is one of the things the probe is for.
func tapDecision(trusted, listen, prompt bool) (create bool, why string) {
	switch {
	case listen:
		return true, ""
	case prompt:
		return true, "creating it without Input Monitoring: macOS may prompt for that too"
	case trusted:
		return true, "creating it with Accessibility alone: if macOS prompts for Input Monitoring, Accessibility does not cover a listen-only tap"
	}
	return false, "not created: neither Accessibility nor Input Monitoring is granted, creating it could prompt, and only --prompt may prompt"
}

// altReportLine is one report as the probe prints it.
func altReportLine(r altReport) string {
	switch r.Kind {
	case altReportDown:
		return "alt down: " + r.Side.String()
	case altReportUp:
		return "alt up: " + r.Side.String()
	case altReportBoth:
		return fmt.Sprintf("alt both: down within %d ms", altBothWindow.Milliseconds())
	case altReportStarted:
		return "hold started: " + r.Side.String()
	case altReportDiscarded:
		return "hold discarded: " + r.Why
	case altReportCounted:
		return fmt.Sprintf("hold counted as a dictation: %s, held %d ms", r.Side, r.Held.Milliseconds())
	}
	return ""
}

func yesNo(b C.int) bool { return b != 0 }

// runAccessibilityProbe is `"Code Foundry" --accessibility-probe [--prompt]`, and returns
// the exit code: 0 once it has watched to the end or was stopped, 1 with no tap.
func runAccessibilityProbe(prompt bool) int {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	// As at a normal launch, so that TCC judges this executable and not the terminal.
	if code, respawned := respawnDisclaimedAndWait(log); respawned {
		return code
	}
	out := os.Stdout
	exe, err := os.Executable()
	if err != nil {
		exe = "unknown: " + err.Error()
	}
	osVersion, err := syscall.Sysctl("kern.osproductversion")
	if err != nil {
		osVersion = "unknown"
	}
	responsible := responsiblePid()
	trusted, listen, post := yesNo(C.cfAXTrusted()), yesNo(C.cfListenAccess()), yesNo(C.cfPostAccess())
	fmt.Fprintln(out, "Code Foundry accessibility probe")
	fmt.Fprintf(out, "version: %s\n", version.Version)
	fmt.Fprintf(out, "executable: %s\n", exe)
	fmt.Fprintf(out, "macOS: %s\n", osVersion)
	fmt.Fprintf(out, "responsible pid: %d (this process is %d; itself: %t)\n", responsible, os.Getpid(), responsible == os.Getpid())
	fmt.Fprintf(out, "AXIsProcessTrusted: %t\n", trusted)
	fmt.Fprintf(out, "CGPreflightListenEventAccess (Input Monitoring): %t\n", listen)
	fmt.Fprintf(out, "CGPreflightPostEventAccess: %t\n", post)
	fmt.Fprintf(out, "the list: System Settings > Privacy & Security > %s\n", accessibilityListName(osVersion))
	if prompt {
		fmt.Fprintln(out, "--prompt: asking for Accessibility")
		trusted = yesNo(C.cfAXPrompt())
		fmt.Fprintf(out, "AXIsProcessTrustedWithOptions (prompt): %t\n", trusted)
	}

	create, why := tapDecision(trusted, listen, prompt)
	if why != "" {
		fmt.Fprintln(out, "event tap: "+why)
	}
	if !create {
		return 1
	}
	tap, err := startAltTap()
	if err != nil {
		fmt.Fprintf(out, "event tap: creation failed: %v\n", err)
		return 1
	}
	defer tap.Stop()
	fmt.Fprintf(out, "event tap: running, listen-only. Hold Alt in a text field in another app. Ctrl-C to stop; exits by itself after %s.\n", probeLimit)
	return watchAltHolds(out, tap.Events, post)
}

// watchAltHolds runs on the main thread (Wails locks main there at init), which is the
// paste's thread, and turns the main run loop between events to keep frontmostApp fresh.
func watchAltHolds(out io.Writer, events <-chan altEvent, post bool) int {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	limit := time.After(probeLimit)
	turn := time.NewTicker(20 * time.Millisecond)
	defer turn.Stop()
	say := func(line string) { fmt.Fprintf(out, "%s %s\n", time.Now().Format("15:04:05.000"), line) }
	var (
		hold    altHold
		pressed frontApp
	)
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				say("event tap: ended by macOS (was the grant removed?)")
				return 1
			}
			if ev.Dropped > 0 {
				say(fmt.Sprintf("event tap: %d events dropped", ev.Dropped))
			}
			switch ev.Kind {
			case altEventDisabledByTimeout:
				say("event tap: disabled by timeout, re-enabled")
			case altEventDisabledByUserInput:
				say("event tap: disabled by user input, re-enabled")
			}
			for _, r := range hold.Step(ev) {
				say(altReportLine(r))
				switch r.Kind {
				case altReportStarted:
					pressed = frontmostApp()
					say(fmt.Sprintf("frontmost at press: %s (pid %d)", pressed.Name, pressed.PID))
				case altReportCounted:
					pasteIfSameApp(pressed, post, say)
				}
			}
		case <-turn.C:
			C.cfTurnMainRunLoop()
		case s := <-sigs:
			say("stopped by " + s.String())
			return 0
		case <-limit:
			say(fmt.Sprintf("%s are up, exiting", probeLimit))
			return 0
		}
	}
}

// pasteIfSameApp does the paste test, if the app in front is still the one Alt went
// down in. It blocks for its waits; events wait in the pipe and keep their times.
func pasteIfSameApp(pressed frontApp, post bool, say func(string)) {
	released := frontmostApp()
	say(fmt.Sprintf("frontmost at release: %s (pid %d)", released.Name, released.PID))
	if released.PID != pressed.PID {
		say("not pasting: the app in front changed during the hold")
		return
	}
	if !post {
		say("CGPreflightPostEventAccess was false at start: macOS may drop the Cmd+V")
	}
	text := "Code Foundry paste test " + time.Now().Format("15:04:05")
	if err := pasteText(&generalPasteboard{}, text, time.Sleep, say); err != nil {
		say("paste failed: " + err.Error())
	}
}

// respawnDisclaimedAndWait is respawnDisclaimed for a foreground command: a terminal must
// not get its prompt back while the probe still prints, and Ctrl-C must still reach it.
// The child shares this process group, so a terminal's signals reach it directly; the
// rest are passed on. respawned false means this process is the one to carry on.
func respawnDisclaimedAndWait(log *slog.Logger) (code int, respawned bool) {
	// Handled, not ignored: an ignored signal would stay ignored in the child.
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigs)
	pid, ok := spawnDisclaimed(log)
	if !ok {
		return 0, false
	}
	go func() {
		for s := range sigs {
			if n, isSys := s.(syscall.Signal); isSys {
				_ = syscall.Kill(pid, n)
			}
		}
	}()
	var status syscall.WaitStatus
	for {
		_, err := syscall.Wait4(pid, &status, 0, nil)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			log.Error("wait for the probe", "err", err)
			return 1, true
		}
		return waitExitCode(status), true
	}
}

// waitExitCode is a finished child's status as a shell would report it.
func waitExitCode(status syscall.WaitStatus) int {
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}
