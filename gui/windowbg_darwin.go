package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

// The macOS appearance as Wails reads it (application_darwin.go isDarkMode), available
// before the application runs: AppleInterfaceStyle is "Dark" in dark mode (including
// Auto while it is dark) and unset in light mode.
static bool cfSystemIsDark(void) {
	NSString* style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
	return style != nil && [style caseInsensitiveCompare:@"Dark"] == NSOrderedSame;
}

static WKWebView* cfFindWebView(NSView* v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView*)v;
	for (NSView* s in v.subviews) {
		WKWebView* w = cfFindWebView(s);
		if (w != nil) return w;
	}
	return nil;
}

// An opaque WKWebView paints its own empty-page colour (white, or #1e1e1e in dark mode)
// until the page's first frame, covering the window's background colour. Without its
// background the window colour (the theme's sheet) shows instead. This is the switch
// Wails' transparent backdrop uses (wailsPrivateSetWebviewTransparent); the page still
// paints its own background over it once it renders.
static void cfClearWebViewBackground(void* nsWindow) {
	NSWindow* w = (__bridge NSWindow*)nsWindow;
	WKWebView* view = w == nil ? nil : cfFindWebView(w.contentView);
	if (view == nil) return;
	@try {
		[view setValue:@NO forKey:@"drawsBackground"];
	} @catch (NSException* e) {
		NSLog(@"Code Foundry: could not clear the webview background: %@", e.reason);
	}
}
*/
import "C"

import "unsafe"

// systemIsDark reports whether macOS is in dark mode.
func systemIsDark() bool { return bool(C.cfSystemIsDark()) }

// clearWebViewBackground lets the window's background colour show through the webview
// wherever the page has not painted. Main thread only.
func clearWebViewBackground(nsWindow unsafe.Pointer) { C.cfClearWebViewBackground(nsWindow) }
