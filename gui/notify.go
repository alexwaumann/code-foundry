package main

import (
	_ "embed"
	"strconv"
	"sync"
)

// alertWAV is the alert sound: "Soft mallet", a wooden double tap, 48 kHz mono 16-bit,
// 0.6 s (docs/sketches/alert-sound has how it was made). Played host-side with NSSound
// (notify_darwin.go), which needs no bundle; the webview's audio is subject to WebKit's
// autoplay policy.
//
//go:embed build/alert.wav
var alertWAV []byte

// holdToneStartWAV and holdToneStopWAV are the hold key's sounds: one Soft mallet knock
// each, 640 Hz and 520 Hz, 48 kHz mono 16-bit, 0.14 s (docs/sketches/alert-sound/taps.py).
//
//go:embed build/dictate-start.wav
var holdToneStartWAV []byte

//go:embed build/dictate-stop.wav
var holdToneStopWAV []byte

// clampVolume clamps an alert volume in percent to 0–100 (0 is silent).
func clampVolume(percent int) int {
	return min(max(percent, 0), 100)
}

// badgeLabel is the Dock badge text for an attention count: "" (no badge) for 0 or less,
// "99+" above 99.
func badgeLabel(count int) string {
	switch {
	case count <= 0:
		return ""
	case count > 99:
		return "99+"
	default:
		return strconv.Itoa(count)
	}
}

// dockBadge remembers the badge label and applies it once the app has finished
// launching. For a bare executable AppKit replaces the Dock tile when launching finishes
// (see icon.go), so a badge set earlier would be lost; the last label set before then is
// applied from the ApplicationDidFinishLaunching handler, after the icon.
type dockBadge struct {
	mu       sync.Mutex
	label    string
	launched bool
	// apply shows a label on the Dock ("" removes the badge). Called with mu held, in
	// the order labels were set.
	apply func(label string)
}

// set records label and applies it if the app has launched and it changed.
func (b *dockBadge) set(label string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if label == b.label {
		return
	}
	b.label = label
	if b.launched {
		b.apply(label)
	}
}

// redraw applies the label again, to a Dock tile made since (menubar_darwin.go).
func (b *dockBadge) redraw() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.launched {
		b.apply(b.label)
	}
}

// didLaunch marks the app launched and applies a label set before then.
func (b *dockBadge) didLaunch() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.launched = true
	if b.label != "" {
		b.apply(b.label)
	}
}
