package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// The Dock badge and bounce for a bare executable. Notification banners are not an
// option: UNUserNotificationCenter needs a bundle proxy, which a binary without a .app
// does not have (docs/notes/dock-alerts.md). Both calls run on the main thread,
// asynchronously, so they are safe from any goroutine and never wait on AppKit.

// cfSetDockBadge sets the Dock tile's badge; an empty label removes it. Takes ownership
// of label (malloc'd), freeing it on the main thread.
static void cfSetDockBadge(char* label) {
	dispatch_async(dispatch_get_main_queue(), ^{
		NSString* s = label[0] == '\0' ? nil : [NSString stringWithUTF8String:label];
		free(label);
		[[NSApp dockTile] setBadgeLabel:s];
	});
}

// cfBounceDock bounces the Dock icon once (NSInformationalRequest). AppKit ignores it
// while the app is active and stops it when the app is activated.
static void cfBounceDock(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		[NSApp requestUserAttention:NSInformationalRequest];
	});
}
*/
import "C"

// setDockBadgeLabel shows label on the Dock icon, or removes the badge for "". Safe from
// any goroutine once the app has finished launching (dockBadge holds labels until then).
func setDockBadgeLabel(label string) {
	C.cfSetDockBadge(C.CString(label))
}

// bounceDock bounces the Dock icon once unless the app is active. Safe from any goroutine.
func bounceDock() {
	C.cfBounceDock()
}
