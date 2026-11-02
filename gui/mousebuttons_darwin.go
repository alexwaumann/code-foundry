package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// cfMouseButton is Go's (mousebuttons_export_darwin.go): it runs the button's command on
// a press and returns whether the button has one.
extern int cfMouseButton(long button, int down);

// A local monitor sees the app's own events before the window dispatches them. A button
// with a command is consumed, press and release, so WebKit never sees it as a middle
// click (which it would report for any button past the third).
static void cfWatchMouseButtons(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		NSEventMask mask = NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp;
		[NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent*(NSEvent* e) {
			int down = e.type == NSEventTypeOtherMouseDown;
			return cfMouseButton((long)e.buttonNumber, down) ? nil : e;
		}];
	});
}
*/
import "C"

import (
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// mouseButtonWindow is the window whose page runs the side buttons' commands.
var mouseButtonWindow atomic.Pointer[application.WebviewWindow]

// forwardMouseButtons makes the mouse's side buttons run Back and Forward in window
// (mousebuttons.go). Call once, before the app runs.
func forwardMouseButtons(window *application.WebviewWindow) {
	mouseButtonWindow.Store(window)
	C.cfWatchMouseButtons()
}

// runMouseButton runs button's command on a press and reports whether it has one.
func runMouseButton(button int, down bool) bool {
	command, ok := mouseButtonCommand(button)
	if !ok {
		return false
	}
	if w := mouseButtonWindow.Load(); down && w != nil {
		// Off the main thread: the monitor runs on it, and emitting may wait for it.
		go w.EmitEvent(EventRunCommand, command)
	}
	return true
}
