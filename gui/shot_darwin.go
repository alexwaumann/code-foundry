package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdint.h>
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/message.h>

// cfShotDone is Go's (shot_export_darwin.go): the snapshot of request token, as PNG bytes,
// or why there is none.
extern void cfShotDone(uintptr_t token, void* png, int length, char* err);

static WKWebView* cfShotWebView(NSView* v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView*)v;
	for (NSView* s in v.subviews) {
		WKWebView* w = cfShotWebView(s);
		if (w != nil) return w;
	}
	return nil;
}

// The window's content, the page's viewport, to width by height points. Main thread only.
static void cfShotSize(void* nsWindow, double width, double height) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	[w setContentSize:NSMakeSize(width, height)];
	// Wails makes the content view a point smaller than the webview inside it, each way.
	WKWebView* view = cfShotWebView(w.contentView);
	if (view != nil) view.frame = w.contentView.bounds;
}

// Orders the window in outside every display, above and right of all of them, at the back
// of its level, without activating the app or making it key. A borderless window keeps the
// frame it is given; a titled one AppKit pulls back onto a screen.
//
// WebKit draws (and runs requestAnimationFrame) only for a page it thinks visible: in a
// window ordered in and not occluded. A window on no display is occluded, so the webview is
// told to ignore occlusion (a private switch, WKWebViewPrivate.h; macOS 10.13 and later).
// Also what Wails has no option for: out of the Window menu and the Dock's window list, and
// no AppKit animation. Returns false when the switch is missing: the page would stay hidden.
// Main thread only.
static bool cfShotOrderIn(void* nsWindow) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	WKWebView* view = cfShotWebView(w.contentView);
	SEL occlusion = NSSelectorFromString(@"_setWindowOcclusionDetectionEnabled:");
	if (view == nil || ![view respondsToSelector:occlusion]) return false;
	((void (*)(id, SEL, BOOL))objc_msgSend)(view, occlusion, NO);
	w.excludedFromWindowsMenu = YES;
	w.animationBehavior = NSWindowAnimationBehaviorNone;
	CGFloat right = 0, top = 0;
	for (NSScreen* s in [NSScreen screens]) {
		right = MAX(right, NSMaxX(s.frame));
		top = MAX(top, NSMaxY(s.frame));
	}
	[w setFrameOrigin:NSMakePoint(right + 4000, top + 4000)];
	[w orderWindow:NSWindowBelow relativeTo:0];
	return true;
}

// Main thread only.
static void cfShotOrderOut(void* nsWindow) {
	[(__bridge NSWindow*)nsWindow orderOut:nil];
}

// Snapshots the window's webview after its next screen update and hands the PNG, in device
// pixels, to cfShotDone. Main thread only; the completion runs on the main thread too.
static void cfShotSnapshot(void* nsWindow, uintptr_t token) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	WKWebView* view = w == nil ? nil : cfShotWebView(w.contentView);
	if (view == nil) {
		cfShotDone(token, NULL, 0, "the shot window has no web view");
		return;
	}
	WKSnapshotConfiguration* config = [[WKSnapshotConfiguration alloc] init];
	config.rect = view.bounds;
	config.afterScreenUpdates = YES;
	[view takeSnapshotWithConfiguration:config completionHandler:^(NSImage* image, NSError* error) {
		if (image == nil) {
			NSString* why = error != nil ? error.localizedDescription : @"no image";
			cfShotDone(token, NULL, 0, (char*)why.UTF8String);
			return;
		}
		CGImageRef cg = [image CGImageForProposedRect:NULL context:nil hints:nil];
		if (cg == NULL) {
			cfShotDone(token, NULL, 0, "the snapshot has no bitmap");
			return;
		}
		NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cg];
		NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
		if (png == nil) {
			cfShotDone(token, NULL, 0, "could not encode the PNG");
		} else {
			cfShotDone(token, (void*)png.bytes, (int)png.length, NULL);
		}
		[rep release];
	}];
	[config release];
}
*/
import "C"

import (
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// shotPage is the window's page: a Vite input of its own (vite.config.ts).
const shotPage = "/shot.html"

// shotBehavior: out of Mission Control (Transient) and of ⌘` (IgnoresCycle).
const shotBehavior = application.MacWindowCollectionBehaviorTransient |
	application.MacWindowCollectionBehaviorIgnoresCycle

// shotWindow is the shot page's window. It is never on a display: WebKit gives a page in a
// window that was never ordered in no animation frames (the page's visibilityState is
// "hidden"), so for each shot it is ordered in outside every display, behind the app's
// other windows and without taking focus, and ordered out after the snapshot. The snapshot is the webview's own (WKWebView takeSnapshot), not a screen
// capture, so it needs no Screen Recording permission.
type shotWindow struct {
	app *application.App
	log *slog.Logger

	mu     sync.Mutex
	window *application.WebviewWindow
}

func newShotWindow(app *application.App, log *slog.Logger) *shotWindow {
	return &shotWindow{app: app, log: log}
}

func (s *shotWindow) open() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.window != nil {
		return
	}
	w := s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                       "plugin-shot",
		Title:                      "Code Foundry Screenshot",
		Width:                      420,
		Height:                     900,
		URL:                        shotPage,
		Hidden:                     true,
		Frameless:                  true,
		DisableResize:              true,
		IgnoreMouseEvents:          true,
		DefaultContextMenuDisabled: true,
		Mac: application.MacWindow{
			// Square: borderless, so it stays where cfShotOrderIn puts it, off every display.
			CornerType:         application.MacWindowCornerTypeSquare,
			DisableShadow:      true,
			CollectionBehavior: shotBehavior,
		},
	})
	s.window = w
	s.log.Info("shot: window opened")
}

func (s *shotWindow) current() *application.WebviewWindow {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.window
}

func (s *shotWindow) show(width, height int, req shotPageRequest) error {
	w := s.current()
	if w == nil {
		return errors.New("the screenshot window is gone")
	}
	js, err := json.Marshal(req)
	if err != nil {
		return err
	}
	var in bool
	application.InvokeSync(func() {
		C.cfShotSize(w.NativeWindow(), C.double(width), C.double(height))
		in = bool(C.cfShotOrderIn(w.NativeWindow()))
	})
	if !in {
		return errors.New("this macOS's WebKit cannot draw a window that is on no display")
	}
	// json.Marshal escapes <, >, &, U+2028 and U+2029: the literal is safe in a script.
	w.ExecJS("window.cfShot(" + string(js) + ")")
	return nil
}

func (s *shotWindow) snapshot() <-chan shotPicture {
	ch := make(chan shotPicture, 1)
	w := s.current()
	if w == nil {
		ch <- shotPicture{err: errors.New("the screenshot window is gone")}
		return ch
	}
	shotSnapshots.Lock()
	shotSnapshots.next++
	token := shotSnapshots.next
	shotSnapshots.open[token] = ch
	shotSnapshots.Unlock()
	application.InvokeAsync(func() { C.cfShotSnapshot(w.NativeWindow(), C.uintptr_t(token)) })
	return ch
}

func (s *shotWindow) hide() {
	if w := s.current(); w != nil {
		application.InvokeSync(func() { C.cfShotOrderOut(w.NativeWindow()) })
	}
}

func (s *shotWindow) close() {
	s.mu.Lock()
	w := s.window
	s.window = nil
	s.mu.Unlock()
	if w != nil {
		w.Close()
	}
}

// shotSnapshots holds each snapshot's channel by its token until cfShotDone. A
// snapshot nobody waits for any more still lands in its buffered channel.
var shotSnapshots = struct {
	sync.Mutex
	next uintptr
	open map[uintptr]chan shotPicture
}{open: map[uintptr]chan shotPicture{}}

// shotSnapshotDone is cfShotDone in Go: it copies the bytes, which live only for the call.
func shotSnapshotDone(token uintptr, png unsafe.Pointer, length int, why *C.char) {
	shotSnapshots.Lock()
	ch := shotSnapshots.open[token]
	delete(shotSnapshots.open, token)
	shotSnapshots.Unlock()
	switch {
	case ch == nil:
	case why != nil:
		ch <- shotPicture{err: errors.New(C.GoString(why))}
	default:
		ch <- shotPicture{png: C.GoBytes(png, C.int(length))}
	}
}
