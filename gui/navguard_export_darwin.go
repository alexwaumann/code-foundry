package main

import "C"

// cfNavigationVerdict is called by the policy method navguard_darwin.go adds to Wails'
// navigation delegate (a file with C definitions in its preamble cannot also export). It
// returns 0 to allow the navigation and anything else to cancel it.
//
//export cfNavigationVerdict
func cfNavigationVerdict(appURL, target *C.char, mainFrame C.int) C.int {
	return C.int(decideNavigation(C.GoString(appURL), C.GoString(target), mainFrame != 0))
}
