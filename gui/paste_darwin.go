package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework ApplicationServices -framework Foundation
#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <stdlib.h>
#include <string.h>

// The paste and what it needs (docs/notes/accessibility-probe.md). Go calls these from
// one thread, and it must be the main thread with its run loop turning: NSWorkspace only
// updates frontmostApplication there. Contents never leave these functions.

// cfPasteMark: see althold_darwin.go.
#define CF_PASTE_MARK 0x43465056
// kVK_ANSI_V: the key's position, which is V on a QWERTY layout only.
#define CF_KEY_V 9
// NX_DEVICELCMDKEYMASK, alongside the generic flag, as a real left Command sets both.
#define CF_DEVICE_LEFT_COMMAND 0x8

// cfFrontmost is the pid of the app in front (0 if none), its name in *name (malloc'd).
static int cfFrontmost(char** name) {
	@autoreleasepool {
		NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
		const char* n = app.localizedName != nil ? app.localizedName.UTF8String : "";
		*name = strdup(n != NULL ? n : "");
		return app != nil ? (int)app.processIdentifier : 0;
	}
}

// cfPasteSave copies the general pasteboard's items, returning a retained array for
// cfPasteRestore. Reading makes the owner render any promised data.
static void* cfPasteSave(int* items, int* skipped) {
	@autoreleasepool {
		NSMutableArray* saved = [[NSMutableArray alloc] init];
		for (NSPasteboardItem* item in [[NSPasteboard generalPasteboard] pasteboardItems]) {
			NSPasteboardItem* copy = [[NSPasteboardItem alloc] init];
			for (NSPasteboardType type in [item types]) {
				NSData* data = [item dataForType:type];
				if (data == nil) {
					(*skipped)++;
					continue;
				}
				[copy setData:data forType:type];
			}
			[saved addObject:copy];
			[copy release];
		}
		*items = (int)saved.count;
		return saved;
	}
}

// cfPasteWrite replaces the general pasteboard with text and the transient marker that
// tells clipboard managers to leave it out of their history (nspasteboard.org). Returns
// the changeCount; *ok is 0 if the write failed after the old contents were cleared.
static long cfPasteWrite(const char* text, int* ok) {
	@autoreleasepool {
		NSPasteboard* pb = [NSPasteboard generalPasteboard];
		[pb clearContents];
		NSPasteboardItem* item = [[[NSPasteboardItem alloc] init] autorelease];
		[item setString:[NSString stringWithUTF8String:text] forType:NSPasteboardTypeString];
		[item setData:[NSData data] forType:@"org.nspasteboard.TransientType"];
		*ok = [pb writeObjects:@[ item ]] ? 1 : 0;
		return (long)[pb changeCount];
	}
}

// cfPastePost posts Cmd+V: V down and up carrying the Command flag, with no Command key
// events of their own, so nothing can be left held. A private source keeps whatever is
// physically down out of the flags. 0 on success.
static int cfPastePost(void) {
	CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
	if (source == NULL) return -1;
	CGEventRef down = CGEventCreateKeyboardEvent(source, CF_KEY_V, true);
	CGEventRef up = CGEventCreateKeyboardEvent(source, CF_KEY_V, false);
	int rc = -1;
	if (down != NULL && up != NULL) {
		CGEventFlags flags = kCGEventFlagMaskCommand | CF_DEVICE_LEFT_COMMAND;
		CGEventSetFlags(down, flags);
		CGEventSetFlags(up, flags);
		CGEventSetIntegerValueField(down, kCGEventSourceUserData, CF_PASTE_MARK);
		CGEventSetIntegerValueField(up, kCGEventSourceUserData, CF_PASTE_MARK);
		CGEventPost(kCGSessionEventTap, down);
		CGEventPost(kCGSessionEventTap, up);
		rc = 0;
	}
	if (down != NULL) CFRelease(down);
	if (up != NULL) CFRelease(up);
	CFRelease(source);
	return rc;
}

// cfPasteRestore puts saved back if the changeCount is still ours, and releases it.
// 1 restored, 0 left alone, -1 failed.
static int cfPasteRestore(void* saved, long ours) {
	@autoreleasepool {
		NSArray* items = [(NSArray*)saved autorelease];
		NSPasteboard* pb = [NSPasteboard generalPasteboard];
		if ((long)[pb changeCount] != ours) return 0;
		[pb clearContents];
		if (items.count == 0) return 1;
		return [pb writeObjects:items] ? 1 : -1;
	}
}
*/
import "C"

import (
	"errors"
	"unsafe"
)

// frontApp is the app in front.
type frontApp struct {
	PID  int
	Name string
}

// frontmostApp reads the app in front. Main thread only (see the C comment).
func frontmostApp() frontApp {
	var name *C.char
	pid := C.cfFrontmost(&name)
	defer C.free(unsafe.Pointer(name))
	return frontApp{PID: int(pid), Name: C.GoString(name)}
}

// generalPasteboard is pasteHost for the real thing.
type generalPasteboard struct {
	saved unsafe.Pointer
}

func (p *generalPasteboard) Save() (items, skipped int) {
	var n, s C.int
	p.saved = C.cfPasteSave(&n, &s)
	return int(n), int(s)
}

func (p *generalPasteboard) Write(text string) (int64, error) {
	ctext := C.CString(text)
	defer C.free(unsafe.Pointer(ctext))
	var ok C.int
	count := int64(C.cfPasteWrite(ctext, &ok))
	if ok == 0 {
		return count, errors.New("the pasteboard refused the write")
	}
	return count, nil
}

func (p *generalPasteboard) Post() error {
	if C.cfPastePost() != 0 {
		return errors.New("could not create the key events")
	}
	return nil
}

func (p *generalPasteboard) Restore(changeCount int64) (bool, error) {
	rc := C.cfPasteRestore(p.saved, C.long(changeCount))
	p.saved = nil
	if rc < 0 {
		return false, errors.New("the pasteboard refused the saved items")
	}
	return rc == 1, nil
}
