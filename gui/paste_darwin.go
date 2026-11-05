package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework AppKit -framework ApplicationServices -framework Foundation
#import <AppKit/AppKit.h>
#include <ApplicationServices/ApplicationServices.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// The paste and what it needs (docs/notes/dictate-anywhere.md). Go calls the pasteboard
// functions from one thread, never the main thread, as reading the pasteboard can wait on
// its owner rendering promised data. cfFrontmost is the opposite: NSWorkspace only updates
// frontmostApplication on the main run loop, so it runs there. Contents never leave these
// functions.

// cfPasteMark: see althold_darwin.go.
#define CF_PASTE_MARK 0x43465056
// kVK_ANSI_V: the key's position, which is V on a QWERTY layout only.
#define CF_KEY_V 9
// NX_DEVICELCMDKEYMASK, alongside the generic flag, as a real left Command sets both.
#define CF_DEVICE_LEFT_COMMAND 0x8

// cfFrontmost is the pid of the app in front (0 if none), its name and bundle path in
// *name and *bundle (malloc'd; "" for none).
static int cfFrontmost(char** name, char** bundle) {
	@autoreleasepool {
		NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
		const char* n = app.localizedName != nil ? app.localizedName.UTF8String : "";
		const char* b = app.bundleURL != nil ? app.bundleURL.path.UTF8String : "";
		*name = strdup(n != NULL ? n : "");
		*bundle = strdup(b != NULL ? b : "");
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

// cfPasteCopy leaves text on the general pasteboard as a normal entry: no transient
// marker, so a clipboard manager keeps it. 1 on success.
static int cfPasteCopy(const char* text) {
	@autoreleasepool {
		NSPasteboard* pb = [NSPasteboard generalPasteboard];
		[pb clearContents];
		return [pb setString:[NSString stringWithUTF8String:text] forType:NSPasteboardTypeString] ? 1 : 0;
	}
}

// CF_TYPE_UNITS: the most UTF-16 units one key event carries.
#define CF_TYPE_UNITS 20

// cfTypeUnits posts one key event pair carrying n UTF-16 units. They replace whatever the
// key would have typed, so the key code does not matter. Line breaks go as characters,
// which is what a web page's field takes.
static int cfTypeUnits(CGEventSourceRef source, const UniChar* units, int n) {
	int rc = -1;
	CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
	CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
	if (down != NULL && up != NULL) {
		CGEventKeyboardSetUnicodeString(down, n, units);
		CGEventKeyboardSetUnicodeString(up, n, units);
		CGEventSetFlags(down, 0);
		CGEventSetFlags(up, 0);
		CGEventSetIntegerValueField(down, kCGEventSourceUserData, CF_PASTE_MARK);
		CGEventSetIntegerValueField(up, kCGEventSourceUserData, CF_PASTE_MARK);
		CGEventPost(kCGSessionEventTap, down);
		CGEventPost(kCGSessionEventTap, up);
		rc = 0;
	}
	if (down != NULL) CFRelease(down);
	if (up != NULL) CFRelease(up);
	return rc;
}

// cfPasteType types text with key events, CF_TYPE_UNITS at a time and never splitting a
// surrogate pair. 0 on success.
static int cfPasteType(const char* text) {
	@autoreleasepool {
		NSString* s = [NSString stringWithUTF8String:text];
		CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
		if (s == nil || source == NULL) {
			if (source != NULL) CFRelease(source);
			return -1;
		}
		NSUInteger length = s.length;
		int rc = 0;
		for (NSUInteger at = 0; rc == 0 && at < length;) {
			NSUInteger n = MIN((NSUInteger)CF_TYPE_UNITS, length - at);
			if (at + n < length && CFStringIsSurrogateHighCharacter([s characterAtIndex:at + n - 1])) n--;
			UniChar units[CF_TYPE_UNITS];
			[s getCharacters:units range:NSMakeRange(at, n)];
			rc = cfTypeUnits(source, units, (int)n);
			at += n;
		}
		CFRelease(source);
		return rc;
	}
}

// CF_AX_TIMEOUT bounds each Accessibility call, in seconds: a hung app must not hold up the
// paste. The first call to time out ends the read.
#define CF_AX_TIMEOUT 0.25f

// cfLastScalar is the last code point of s, 0 when s is empty or ends in half a surrogate
// pair. Takes ownership of s.
static uint32_t cfLastScalar(CFStringRef s) {
	uint32_t scalar = 0;
	CFIndex n = CFStringGetLength(s);
	if (n > 0) {
		UniChar last = CFStringGetCharacterAtIndex(s, n - 1);
		if (CFStringIsSurrogateLowCharacter(last)) {
			UniChar high = n > 1 ? CFStringGetCharacterAtIndex(s, n - 2) : 0;
			if (CFStringIsSurrogateHighCharacter(high)) scalar = CFStringGetLongCharacterForSurrogatePair(high, last);
		} else if (!CFStringIsSurrogateHighCharacter(last)) {
			scalar = last;
		}
	}
	CFRelease(s);
	return scalar;
}

// cfStringForRange reads one range of a text element: a code point, or 0.
static uint32_t cfStringForRange(AXUIElementRef focused, CFRange range) {
	AXValueRef param = AXValueCreate(kAXValueTypeCFRange, &range);
	if (param == NULL) return 0;
	CFTypeRef value = NULL;
	AXError err = AXUIElementCopyParameterizedAttributeValue(focused, kAXStringForRangeParameterizedAttribute, param, &value);
	CFRelease(param);
	if (err != kAXErrorSuccess || value == NULL) return 0;
	if (CFGetTypeID(value) != CFStringGetTypeID()) {
		CFRelease(value);
		return 0;
	}
	return cfLastScalar((CFStringRef)value);
}

// cfPasswordField reports whether pid's focused element is a password field, 0 when the app
// does not say: a paste into a field we cannot see is what the user asked for.
static int cfPasswordField(int pid) {
	AXUIElementRef app = AXUIElementCreateApplication(pid);
	if (app == NULL) return 0;
	AXUIElementSetMessagingTimeout(app, CF_AX_TIMEOUT);
	CFTypeRef focused = NULL;
	AXError err = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused);
	CFRelease(app);
	if (err != kAXErrorSuccess || focused == NULL) return 0;
	int secure = 0;
	if (CFGetTypeID(focused) == AXUIElementGetTypeID()) {
		AXUIElementSetMessagingTimeout((AXUIElementRef)focused, CF_AX_TIMEOUT);
		CFTypeRef subrole = NULL;
		if (AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSubroleAttribute, &subrole) == kAXErrorSuccess && subrole != NULL) {
			secure = CFGetTypeID(subrole) == CFStringGetTypeID() && CFEqual(subrole, kAXSecureTextFieldSubrole);
			CFRelease(subrole);
		}
	}
	CFRelease(focused);
	return secure;
}

// cfCharBeforeCaret is the character just before the insertion point of pid's focused text
// element: 0 with text selected, at the very start, or when the app does not say. It only
// reads, and never prompts. Not on the tap's thread or the main thread: it waits on the app.
static uint32_t cfCharBeforeCaret(int pid) {
	AXUIElementRef app = AXUIElementCreateApplication(pid);
	if (app == NULL) return 0;
	AXUIElementSetMessagingTimeout(app, CF_AX_TIMEOUT);
	CFTypeRef focused = NULL;
	AXError err = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &focused);
	CFRelease(app);
	if (err != kAXErrorSuccess || focused == NULL) return 0;
	uint32_t scalar = 0;
	CFTypeRef selection = NULL;
	if (CFGetTypeID(focused) == AXUIElementGetTypeID()) {
		AXUIElementSetMessagingTimeout((AXUIElementRef)focused, CF_AX_TIMEOUT);
		err = AXUIElementCopyAttributeValue((AXUIElementRef)focused, kAXSelectedTextRangeAttribute, &selection);
	}
	CFRange range = {0, 0};
	if (selection != NULL && err == kAXErrorSuccess && CFGetTypeID(selection) == AXValueGetTypeID() &&
		AXValueGetValue((AXValueRef)selection, kAXValueTypeCFRange, &range) && range.length == 0 && range.location > 0) {
		// One UTF-16 unit, or two when it is half of a surrogate pair.
		for (CFIndex units = 1; scalar == 0 && units <= 2 && units <= range.location; units++) {
			scalar = cfStringForRange((AXUIElementRef)focused, CFRangeMake(range.location - units, units));
		}
	}
	if (selection != NULL) CFRelease(selection);
	CFRelease(focused);
	return scalar;
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

// frontmostApp reads the app in front. Main thread only (see the C comment).
func frontmostApp() frontApp {
	var name, bundle *C.char
	pid := C.cfFrontmost(&name, &bundle)
	defer C.free(unsafe.Pointer(name))
	defer C.free(unsafe.Pointer(bundle))
	return frontApp{PID: int(pid), Name: C.GoString(name), Bundle: C.GoString(bundle)}
}

// passwordField reports whether a password field has the keyboard in app pid.
func passwordField(pid int) bool { return C.cfPasswordField(C.int(pid)) != 0 }

// copyToClipboard leaves text on the clipboard as a normal entry.
func copyToClipboard(text string) error {
	ctext := C.CString(text)
	defer C.free(unsafe.Pointer(ctext))
	if C.cfPasteCopy(ctext) == 0 {
		return errors.New("the pasteboard refused the text")
	}
	return nil
}

// typeText types text into the app in front.
func typeText(text string) error {
	ctext := C.CString(text)
	defer C.free(unsafe.Pointer(ctext))
	if C.cfPasteType(ctext) != 0 {
		return errors.New("could not create the key events")
	}
	return nil
}

// charBeforeCaret reads the character before pid's caret. Waits on the app, bounded; never
// from the tap's thread or the main thread.
func charBeforeCaret(pid int) (rune, bool) {
	r := rune(C.cfCharBeforeCaret(C.int(pid)))
	return r, r != 0
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
