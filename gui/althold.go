package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"strings"
	"time"
)

// The bits of a CGEvent's flags that the hold reads. The two Alt bits are the
// device-dependent ones (NX_DEVICELALTKEYMASK, NX_DEVICERALTKEYMASK): the generic Alternate
// flag cannot tell the sides apart.
const (
	flagLeftAlt  uint64 = 0x20
	flagRightAlt uint64 = 0x40
	flagCapsLock uint64 = 0x10000
	flagShift    uint64 = 0x20000
	flagControl  uint64 = 0x40000
	flagCommand  uint64 = 0x100000
	flagFn       uint64 = 0x800000

	// heldModifiers are the modifiers that are down only while held. Caps Lock is not one:
	// it stays set once on, so only a change in it means the key was pressed.
	heldModifiers = flagShift | flagControl | flagCommand | flagFn
)

const (
	// altHoldMin is how long Alt must stay down to count. Under it, Alt was a tap.
	altHoldMin = 300 * time.Millisecond
	// altBothWindow is how close the two Alts must go down to be one press of both.
	altBothWindow = 80 * time.Millisecond
)

// altEventKind matches cfAltRecord's kind in althold_darwin.go.
type altEventKind uint32

const (
	altEventFlags altEventKind = iota
	altEventKeyDown
	altEventDisabledByTimeout
	altEventDisabledByUserInput
)

// altEvent is one event from the tap.
type altEvent struct {
	Kind    altEventKind
	At      time.Duration // on a monotonic clock
	Flags   uint64
	KeyCode uint32
	Dropped uint32 // records lost to a full pipe just before this one
}

// altRecordSize is sizeof(cfAltRecord).
const altRecordSize = 32

// decodeAltRecord reads one cfAltRecord (arm64 is little-endian).
func decodeAltRecord(b []byte) altEvent {
	return altEvent{
		Kind:    altEventKind(binary.LittleEndian.Uint32(b[0:])),
		Dropped: binary.LittleEndian.Uint32(b[4:]),
		Flags:   binary.LittleEndian.Uint64(b[8:]),
		At:      time.Duration(binary.LittleEndian.Uint64(b[16:])),
		KeyCode: binary.LittleEndian.Uint32(b[24:]),
	}
}

// pumpAltEvents reads the tap's pipe until it ends, then closes out.
func pumpAltEvents(r io.Reader, out chan<- altEvent) {
	defer close(out)
	var b [altRecordSize]byte
	for {
		if _, err := io.ReadFull(r, b[:]); err != nil {
			return
		}
		out <- decodeAltRecord(b[:])
	}
}

// altSide is which Alt a report is about.
type altSide int

const (
	altLeft altSide = iota
	altRight
	altBothSides
)

func (s altSide) String() string {
	switch s {
	case altLeft:
		return "left"
	case altRight:
		return "right"
	}
	return "both"
}

// altReportKind is what happened.
type altReportKind int

const (
	altReportDown      altReportKind = iota // an Alt went down
	altReportUp                             // an Alt came up
	altReportBoth                           // the second Alt joined the first within altBothWindow
	altReportStarted                        // a clean press began a hold
	altReportDiscarded                      // this hold will not count, because of Why
	altReportCounted                        // a hold ended and counts as a dictation
)

// altReport is one thing the machine has to say. Held is set on Counted and on a
// Discarded that came at the release.
type altReport struct {
	Kind altReportKind
	Side altSide
	Held time.Duration
	Why  string
}

// altHold decides whether Alt was held alone, as a dictation. The rule is Hex's: Alt
// pressed alone and held at least altHoldMin, then released, counts; a shorter hold, or
// any other key or modifier pressed during it, is discarded, so Alt+arrow and Alt+letter
// stay what they were. A hold runs from the first Alt down to the last Alt up. It only
// observes: the zero value is ready, and nothing here touches the event stream.
//
// Alt's state comes from each event's flags, not from counting edges, so an event lost
// to a full pipe or a disabled tap is corrected by the next one.
type altHold struct {
	left, right bool
	flags       uint64 // as of the last flags event

	active  bool // from the first Alt down to the last Alt up
	spoiled bool // discarded already; it only waits for the release
	both    bool
	first   altSide
	start   time.Duration
}

// Step feeds one event in and says what it meant, in order.
func (h *altHold) Step(ev altEvent) []altReport {
	switch ev.Kind {
	case altEventKeyDown:
		if h.active {
			return h.spoil(fmt.Sprintf("key %d pressed during the hold", ev.KeyCode))
		}
	case altEventFlags:
		return h.flagsChanged(ev)
	case altEventDisabledByTimeout:
		return h.interrupt("macOS disabled the tap (timeout)")
	case altEventDisabledByUserInput:
		return h.interrupt("macOS disabled the tap (user input)")
	}
	return nil
}

func (h *altHold) flagsChanged(ev altEvent) []altReport {
	var out []altReport
	pressed := ev.Flags &^ h.flags & heldModifiers
	pressed |= (ev.Flags ^ h.flags) & flagCapsLock
	if h.active && pressed != 0 {
		out = append(out, h.spoil(modifierNames(pressed)+" pressed during the hold")...)
	}
	h.flags = ev.Flags
	left, right := ev.Flags&flagLeftAlt != 0, ev.Flags&flagRightAlt != 0
	if left != h.left {
		h.left = left
		out = append(out, h.sideChanged(altLeft, left, ev)...)
	}
	if right != h.right {
		h.right = right
		out = append(out, h.sideChanged(altRight, right, ev)...)
	}
	return out
}

func (h *altHold) sideChanged(side altSide, down bool, ev altEvent) []altReport {
	if down {
		return h.press(side, ev)
	}
	return h.release(side, ev.At)
}

func (h *altHold) press(side altSide, ev altEvent) []altReport {
	out := []altReport{{Kind: altReportDown, Side: side}}
	if !h.active {
		h.active, h.spoiled, h.both = true, false, false
		h.first, h.start = side, ev.At
		if held := ev.Flags & heldModifiers; held != 0 {
			return append(out, h.spoil("pressed with "+modifierNames(held))...)
		}
		return append(out, altReport{Kind: altReportStarted, Side: side})
	}
	since := ev.At - h.start
	if !h.both && side != h.first && since <= altBothWindow {
		h.both = true
		return append(out, altReport{Kind: altReportBoth, Side: altBothSides})
	}
	return append(out, h.spoil(fmt.Sprintf("%s Alt went down %d ms into the hold", side, since.Milliseconds()))...)
}

func (h *altHold) release(side altSide, at time.Duration) []altReport {
	out := []altReport{{Kind: altReportUp, Side: side}}
	if !h.active || h.left || h.right {
		return out
	}
	h.active = false
	if h.spoiled {
		return out
	}
	held := at - h.start
	if held < altHoldMin {
		return append(out, altReport{
			Kind: altReportDiscarded,
			Held: held,
			Why:  fmt.Sprintf("held %d ms, under %d ms", held.Milliseconds(), altHoldMin.Milliseconds()),
		})
	}
	counted := h.first
	if h.both {
		counted = altBothSides
	}
	return append(out, altReport{Kind: altReportCounted, Side: counted, Held: held})
}

// spoil discards the hold in progress, once. It still runs until the last Alt comes up,
// so the rest of it cannot start a new one.
func (h *altHold) spoil(why string) []altReport {
	if h.spoiled {
		return nil
	}
	h.spoiled = true
	return []altReport{{Kind: altReportDiscarded, Why: why}}
}

// interrupt forgets everything: while the tap was off, events went by unseen.
func (h *altHold) interrupt(why string) []altReport {
	var out []altReport
	if h.active {
		out = h.spoil(why)
	}
	*h = altHold{}
	return out
}

// modifierNames names the modifier bits in bits.
func modifierNames(bits uint64) string {
	var names []string
	for _, m := range []struct {
		bit  uint64
		name string
	}{
		{flagShift, "Shift"},
		{flagControl, "Control"},
		{flagCommand, "Command"},
		{flagFn, "Fn"},
		{flagCapsLock, "Caps Lock"},
	} {
		if bits&m.bit != 0 {
			names = append(names, m.name)
		}
	}
	return strings.Join(names, "+")
}
