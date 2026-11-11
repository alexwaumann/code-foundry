package main

// #include <stdint.h>
import "C"

import "unsafe"

// cfShotDone is called by the snapshot's completion in shot_darwin.go (a file with C
// definitions in its preamble cannot also export).
//
//export cfShotDone
func cfShotDone(token C.uintptr_t, png unsafe.Pointer, length C.int, why *C.char) {
	shotSnapshotDone(uintptr(token), png, int(length), why)
}
