package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>
#include <stdlib.h>

// The Dock badge, bounce and alert sound for a bare executable. Notification banners are not an
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

// alertSound is the alert NSSound, created once by cfLoadAlertSound and kept for the
// life of the process (retained by alloc/init; only touched on the main thread).
static NSSound* alertSound;

// cfLoadAlertSound creates the alert sound from WAV bytes. Takes ownership of data
// (malloc'd), freeing it on the main thread. NSSound needs no bundle.
static void cfLoadAlertSound(void* data, int len) {
	dispatch_async(dispatch_get_main_queue(), ^{
		NSData* d = [NSData dataWithBytes:data length:len];
		free(data);
		if (alertSound == nil) alertSound = [[NSSound alloc] initWithData:d];
	});
}

// cfPlayAlertSound plays the alert sound at volume (0 to 1, relative to the Mac's output
// volume), restarting it if it is still playing. Queued after cfLoadAlertSound.
static void cfPlayAlertSound(float volume) {
	dispatch_async(dispatch_get_main_queue(), ^{
		if (alertSound == nil) return;
		[alertSound setVolume:volume];
		if ([alertSound isPlaying]) [alertSound stop];
		[alertSound play];
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

import "sync"

// setDockBadgeLabel shows label on the Dock icon, or removes the badge for "". Safe from
// any goroutine once the app has finished launching (dockBadge holds labels until then).
func setDockBadgeLabel(label string) {
	C.cfSetDockBadge(C.CString(label))
}

// bounceDock bounces the Dock icon once unless the app is active. Safe from any goroutine.
func bounceDock() {
	C.cfBounceDock()
}

var loadAlertSound = sync.OnceFunc(func() {
	C.cfLoadAlertSound(C.CBytes(alertWAV), C.int(len(alertWAV)))
})

// playAlertSound plays the alert sound at volume (0 to 1), creating the NSSound on first
// use. Safe from any goroutine; returns at once.
func playAlertSound(volume float64) {
	loadAlertSound()
	C.cfPlayAlertSound(C.float(volume))
}
