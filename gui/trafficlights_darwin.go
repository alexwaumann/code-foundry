package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// The traffic lights are native, so the page zoom (CSS zoom on <html>) cannot move
// them. Like T3 Code (Electron's setWindowButtonPosition) we move them with the zoomed
// title band instead: centerY is the pane headers' centre in points below the window's
// top edge (buttonCenterY below). AppKit lays the title bar out again on resize and when leaving full screen,
// so the position is re-applied from those notifications. Observers are installed once
// per window; the target lives in an associated object on the window.

static char kCFButtonCenterYKey;

static void cfApplyWindowButtons(NSWindow* w) {
	NSNumber* target = objc_getAssociatedObject(w, &kCFButtonCenterYKey);
	if (target == nil || ([w styleMask] & NSWindowStyleMaskFullScreen)) return;
	double centerY = target.doubleValue;
	NSButton* buttons[3] = {
		[w standardWindowButton:NSWindowCloseButton],
		[w standardWindowButton:NSWindowMiniaturizeButton],
		[w standardWindowButton:NSWindowZoomButton],
	};
	for (int i = 0; i < 3; i++) {
		NSButton* b = buttons[i];
		NSView* bar = b.superview;
		if (b == nil || bar == nil) continue;
		NSRect f = b.frame;
		// The title bar view is bottom-left origin unless flipped.
		double y = bar.isFlipped ? centerY - f.size.height / 2 : bar.frame.size.height - centerY - f.size.height / 2;
		if (f.origin.y == y) continue;
		f.origin.y = y;
		b.frame = f;
	}
}

static void cfSetWindowButtonCenterY(void* nsWindow, double centerY) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	dispatch_async(dispatch_get_main_queue(), ^{
		BOOL installed = objc_getAssociatedObject(w, &kCFButtonCenterYKey) != nil;
		objc_setAssociatedObject(w, &kCFButtonCenterYKey, @(centerY), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
		if (!installed) {
			NSNotificationCenter* nc = [NSNotificationCenter defaultCenter];
			NSArray* names = @[NSWindowDidResizeNotification, NSWindowDidEndLiveResizeNotification, NSWindowDidExitFullScreenNotification, NSWindowDidBecomeKeyNotification];
			for (NSString* name in names) {
				[nc addObserverForName:name object:w queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification* note) {
					cfApplyWindowButtons((NSWindow*)note.object);
				}];
			}
		}
		cfApplyWindowButtons(w);
	});
}
*/
import "C"

import "unsafe"

// The title band's geometry in CSS px at 100% zoom (points on screen), copied from
// frontend/src/components/window/titleBand.ts: the panes start shellGap below the window
// top (SHELL_GAP, --gap-shell) and their headers are paneHeaderHeight tall
// (PANE_HEADER_HEIGHT). The band is the two together (TITLE_BAND_HEIGHT, 56) and its
// content centres on the header, not the band (TITLE_BAND_CENTER, 34).
const (
	shellGap         = 12
	paneHeaderHeight = 44
)

// buttonCenterY is where the traffic lights centre, in points below the window's top
// edge, at a page zoom (percent): the pane header's middle, zoomed.
func buttonCenterY(zoomPercent int) float64 {
	return (shellGap + paneHeaderHeight/2.0) * float64(zoomPercent) / 100
}

// positionWindowButtons centres the traffic lights on the pane headers at the given page
// zoom (percent). Safe from any goroutine; the work runs on the main thread.
func positionWindowButtons(nsWindow unsafe.Pointer, zoomPercent int) {
	if nsWindow == nil || zoomPercent <= 0 {
		return
	}
	C.cfSetWindowButtonCenterY(nsWindow, C.double(buttonCenterY(zoomPercent)))
}
