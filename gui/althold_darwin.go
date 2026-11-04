package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework ApplicationServices -framework CoreFoundation -framework Foundation
#import <Foundation/Foundation.h>
#include <ApplicationServices/ApplicationServices.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// A listen-only event tap for the hold key (docs/notes/dictate-anywhere.md): Option still
// reaches other apps. Everything here runs on the one thread that created the tap, except
// cfAltTapStop. The callback never enters Go: it writes a fixed-size record to a pipe that
// Go reads, and a full pipe drops the record rather than hold up the tap.

// cfAltRecord is decoded by decodeAltRecord. Under PIPE_BUF, so a write is all or nothing.
typedef struct {
	uint32_t kind;    // altEventKind
	uint32_t dropped; // records lost since the last one written
	uint64_t flags;
	uint64_t at;      // CLOCK_UPTIME_RAW, ns: when the tap saw it
	uint32_t keycode;
	uint32_t pad;
} cfAltRecord;
_Static_assert(sizeof(cfAltRecord) == 32, "altRecordSize");

// cfPasteMark is the source user data on the events paste_darwin.go posts, so the tap
// does not read our own Cmd+V as the user's keys. Keep the two in step.
#define CF_PASTE_MARK 0x43465056

typedef struct {
	CFMachPortRef port;
	CFRunLoopSourceRef source;
	CFRunLoopRef loop;
	CFRunLoopTimerRef health;
	void* activity; // id; cgo cannot size an id field
	int fd;
	uint32_t dropped;
	atomic_bool stopping;
} cfAltTap;

// CF_TAP_HEALTH_SECONDS: how often the tap's thread checks that macOS left it running.
#define CF_TAP_HEALTH_SECONDS 5.0

static void cfAltTapSend(cfAltTap* t, uint32_t kind, CGEventRef event) {
	cfAltRecord r;
	memset(&r, 0, sizeof r);
	r.kind = kind;
	r.dropped = t->dropped;
	r.at = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
	if (event != NULL) {
		r.flags = (uint64_t)CGEventGetFlags(event);
		r.keycode = (uint32_t)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
	}
	if (write(t->fd, &r, sizeof r) == (ssize_t)sizeof r) {
		t->dropped = 0;
	} else {
		t->dropped++;
	}
}

static CGEventRef cfAltTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* info) {
	cfAltTap* t = info;
	switch (type) {
	case kCGEventTapDisabledByTimeout:
	case kCGEventTapDisabledByUserInput:
		CGEventTapEnable(t->port, true);
		cfAltTapSend(t, type == kCGEventTapDisabledByTimeout ? 2 : 3, NULL);
		return event;
	case kCGEventFlagsChanged:
	case kCGEventKeyDown:
		if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) != CF_PASTE_MARK) {
			cfAltTapSend(t, type == kCGEventFlagsChanged ? 0 : 1, event);
		}
		return event;
	default:
		return event;
	}
}

// cfAltTapHealth catches what the callback cannot: macOS can disable a tap without
// telling it, and a tap can be invalidated. A disabled tap reads as one disabled by
// timeout, which discards a hold in progress. An invalid one ends the run loop, which
// closes the pipe: Go then makes a new one.
static void cfAltTapHealth(CFRunLoopTimerRef timer, void* info) {
	cfAltTap* t = info;
	if (!CFMachPortIsValid(t->port)) {
		atomic_store(&t->stopping, true);
		CFRunLoopStop(t->loop);
	} else if (!CGEventTapIsEnabled(t->port)) {
		CGEventTapEnable(t->port, true);
		cfAltTapSend(t, 2, NULL);
	}
}

// cfAltTapCreate makes the tap on this thread's run loop, writing to fd (duplicated, and
// non-blocking). NULL when macOS refuses it, which is the only reason it gives.
static cfAltTap* cfAltTapCreate(int fd) {
	cfAltTap* t = calloc(1, sizeof *t);
	t->fd = dup(fd);
	if (t->fd < 0) {
		free(t);
		return NULL;
	}
	fcntl(t->fd, F_SETNOSIGPIPE, 1);
	fcntl(t->fd, F_SETFL, fcntl(t->fd, F_GETFL) | O_NONBLOCK);
	CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged) | CGEventMaskBit(kCGEventKeyDown);
	t->port = CGEventTapCreate(kCGAnnotatedSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, cfAltTapCallback, t);
	if (t->port == NULL) {
		close(t->fd);
		free(t);
		return NULL;
	}
	t->source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t->port, 0);
	t->loop = (CFRunLoopRef)CFRetain(CFRunLoopGetCurrent());
	CFRunLoopAddSource(t->loop, t->source, kCFRunLoopCommonModes);
	CFRunLoopTimerContext context = {0, t, NULL, NULL, NULL};
	t->health = CFRunLoopTimerCreate(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + CF_TAP_HEALTH_SECONDS, CF_TAP_HEALTH_SECONDS, 0, 0, cfAltTapHealth, &context);
	CFRunLoopAddTimer(t->loop, t->health, kCFRunLoopCommonModes);
	CGEventTapEnable(t->port, true);
	// A hidden app can be napped, and a napped callback misses its deadline and gets the
	// tap disabled. Idle sleep stays allowed.
	t->activity = [[[NSProcessInfo processInfo] beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep reason:@"Listening for the dictation hold key"] retain];
	return t;
}

// cfAltTapRun runs this thread's run loop until cfAltTapStop or the tap is invalidated.
// The loop's own timeout covers a stop that lands just before the run loop is entered.
static void cfAltTapRun(cfAltTap* t) {
	while (!atomic_load(&t->stopping)) {
		@autoreleasepool {
			CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1.0, false);
		}
	}
}

// cfAltTapStop is the one call from another thread; CFRunLoopStop allows it.
static void cfAltTapStop(cfAltTap* t) {
	atomic_store(&t->stopping, true);
	CFRunLoopStop(t->loop);
}

// cfAltTapFree closes the tap and the pipe (the reader then sees EOF), and frees t.
static void cfAltTapFree(cfAltTap* t) {
	[[NSProcessInfo processInfo] endActivity:(id)t->activity];
	[(id)t->activity release];
	CFRunLoopTimerInvalidate(t->health);
	CFRelease(t->health);
	CGEventTapEnable(t->port, false);
	CFRunLoopRemoveSource(t->loop, t->source, kCFRunLoopCommonModes);
	CFMachPortInvalidate(t->port);
	CFRelease(t->source);
	CFRelease(t->port);
	CFRelease(t->loop);
	close(t->fd);
	free(t);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sync"
)

// altTap is a running tap. Events arrive on Events until Stop, or until macOS ends the
// tap, and the channel then closes.
type altTap struct {
	events <-chan altEvent

	mu     sync.Mutex
	native *C.cfAltTap // nil once its thread has freed it
	done   chan struct{}
}

// Events implements altListener.
func (t *altTap) Events() <-chan altEvent { return t.events }

// startAltTap creates the tap on its own locked thread, which stays in the tap's run
// loop for as long as it lives. Creating it may show macOS's Input Monitoring prompt
// when that is undecided, so it is only ever called with Accessibility granted.
func startAltTap() (*altTap, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("event tap: %w", err)
	}
	t := &altTap{done: make(chan struct{})}
	created := make(chan bool)
	go func() {
		// Never unlocked: the thread goes when this goroutine does, with its run loop.
		runtime.LockOSThread()
		defer close(t.done)
		native := C.cfAltTapCreate(C.int(w.Fd()))
		t.native = native
		created <- native != nil
		if native == nil {
			return
		}
		C.cfAltTapRun(native)
		t.mu.Lock()
		t.native = nil
		t.mu.Unlock()
		C.cfAltTapFree(native)
	}()
	ok := <-created
	// The tap holds its own copy of the write end; freeing it ends the reader below.
	_ = w.Close()
	if !ok {
		_ = r.Close()
		return nil, errors.New("CGEventTapCreate returned NULL")
	}
	events := make(chan altEvent, 256)
	t.events = events
	go func() {
		pumpAltEvents(r, events)
		_ = r.Close()
	}()
	return t, nil
}

// Stop ends the tap and waits for its thread to let go of it.
func (t *altTap) Stop() {
	t.mu.Lock()
	if t.native != nil {
		C.cfAltTapStop(t.native)
	}
	t.mu.Unlock()
	<-t.done
}
