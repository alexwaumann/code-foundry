package main

import "C"

// cfMouseButton is called by the native monitor in mousebuttons_darwin.go (a file with
// C definitions in its preamble cannot also export). It returns 1 when the button has a
// command, so the monitor consumes the event.
//
//export cfMouseButton
func cfMouseButton(button C.long, down C.int) C.int {
	if runMouseButton(int(button), down != 0) {
		return 1
	}
	return 0
}
