package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework ApplicationServices -framework Carbon -framework Foundation
#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>

// What the hold key reads from macOS (docs/notes/dictate-anywhere.md). None of these
// prompts, except cfAXAsk, which is what it is for.

static int cfAXTrusted(void) { return AXIsProcessTrusted() ? 1 : 0; }

static int cfSecureInput(void) { return IsSecureEventInputEnabled() ? 1 : 0; }

// cfAtLeastMacOS27: the list of grants has another name from then on.
static int cfAtLeastMacOS27(void) {
	NSOperatingSystemVersion v = {27, 0, 0};
	return [[NSProcessInfo processInfo] isOperatingSystemAtLeastVersion:v] ? 1 : 0;
}

// cfKeyAge is the seconds since a key was pressed in this login session, a modifier
// included. The combined state counts what a session tap sees, posted events too, and
// reading it needs no grant.
static double cfKeyAge(void) {
	double key = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown);
	double flags = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventFlagsChanged);
	return key < flags ? key : flags;
}

// cfAXAsk asks for Accessibility, which also adds this executable to the list, and opens
// the list in System Settings. The anchor is the same from macOS 13 to 27. On the main
// queue, so it is safe from any goroutine and never waits on AppKit.
static void cfAXAsk(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		const void* keys[] = {kAXTrustedCheckOptionPrompt};
		const void* values[] = {kCFBooleanTrue};
		CFDictionaryRef options = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
		AXIsProcessTrustedWithOptions(options);
		CFRelease(options);
		NSURL* pane = [NSURL URLWithString:@"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility"];
		[[NSWorkspace sharedWorkspace] openURL:pane];
	});
}
*/
import "C"

import (
	"log/slog"
	"os"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// macHoldOS is holdOS on macOS.
type macHoldOS struct {
	duck *ducker
}

// newMacHoldService returns the hold key's service for this Mac.
func newMacHoldService(log *slog.Logger, duck *ducker) *holdService {
	exe, err := os.Executable()
	if err != nil {
		log.Warn("dictation: this executable's path", "err", err)
	}
	return newHoldService(macHoldOS{duck: duck}, accessibilityListName(C.cfAtLeastMacOS27() != 0), exe, log)
}

// askAccessibility is dictation.allow. Safe from any goroutine; returns at once.
func askAccessibility() { C.cfAXAsk() }

func (macHoldOS) frontmost() frontApp {
	var app frontApp
	application.InvokeSync(func() { app = frontmostApp() })
	return app
}

func (macHoldOS) secureInput() bool { return C.cfSecureInput() != 0 }

func (macHoldOS) trusted() bool { return C.cfAXTrusted() != 0 }

func (macHoldOS) keyAge() time.Duration {
	return time.Duration(float64(C.cfKeyAge()) * float64(time.Second))
}

func (macHoldOS) startTap() (altListener, error) {
	tap, err := startAltTap()
	if err != nil {
		return nil, err
	}
	return tap, nil
}

func (macHoldOS) playTone(t holdTone, volume int) { playHoldTone(t, float64(clampVolume(volume))/100) }

func (macHoldOS) charBeforeCaret(pid int) (rune, bool) { return charBeforeCaret(pid) }

func (m macHoldOS) lowerAudio(after time.Duration, released <-chan struct{}) {
	m.duck.lower(after, released)
}

func (macHoldOS) pasteboard() pasteHost { return &generalPasteboard{} }

func (macHoldOS) copyText(text string) error { return copyToClipboard(text) }

func (macHoldOS) typeText(text string) error { return typeText(text) }
