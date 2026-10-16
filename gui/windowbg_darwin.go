package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Foundation
#import <Foundation/Foundation.h>

// The macOS appearance as Wails reads it (application_darwin.go isDarkMode), available
// before the application runs: AppleInterfaceStyle is "Dark" in dark mode (including
// Auto while it is dark) and unset in light mode.
static bool cfSystemIsDark(void) {
	NSString* style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
	return style != nil && [style caseInsensitiveCompare:@"Dark"] == NSOrderedSame;
}
*/
import "C"

// systemIsDark reports whether macOS is in dark mode.
func systemIsDark() bool { return bool(C.cfSystemIsDark()) }
