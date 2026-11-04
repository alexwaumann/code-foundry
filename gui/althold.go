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
	// altHoldMin is how long the key must stay down to count. Under it, it was a tap. It is
	// also how long a modifier can still cancel the hold.
	altHoldMin = 300 * time.Millisecond
	// altBothWindow is how close the two Alts must go down to be one press of both. A real
	// press measured 83 ms.
	altBothWindow = 150 * time.Millisecond
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

// holdKeyMode is dictation.hold_key: which Option key, or keys, make a hold.
type holdKeyMode int

const (
	holdEither holdKeyMode = iota // the zero value, as the setting's default
	holdLeft
	holdRight
	holdBoth
)

// parseHoldKey reads dictation.hold_key. The daemon validates it; anything else (an older
// daemon sends "") reads as the default.
func parseHoldKey(s string) holdKeyMode {
	switch s {
	case "left":
		return holdLeft
	case "right":
		return holdRight
	case "both":
		return holdBoth
	}
	return holdEither
}

// altReportKind is what happened to a hold.
type altReportKind int

const (
	altReportStarted   altReportKind = iota // the key went down: open the session
	altReportDiscarded                      // the hold is over and does not count, because of Why
	altReportCounted                        // the key came up on a hold that counts
)

// altReport is one thing the machine has to say. Every Started is followed by exactly one
// Discarded or Counted. Why never names a key: logs must not read as a keylogger's.
type altReport struct {
	Kind altReportKind
	Held time.Duration // on Counted, and on a Discarded that came at the release
	Why  string
}

// holdPhase is where a press has got to.
type holdPhase int

const (
	phaseIdle    holdPhase = iota // nothing down that matters
	phaseArming                   // holdBoth: one key down, waiting for the other
	phaseHolding                  // a hold runs
	phaseWaiting                  // this press will not start or count: wait for the keys to come up
)

// altHold decides whether the hold key was held, as a dictation. The rules start from
// Hex's and differ on one point: Hex's hold ends with any other key or modifier, and here
// a modifier only cancels in the first altHoldMin, because a real hold was lost to a second
// Option key 15.7 s in. A key that is not a modifier cancels at any time: Option plus a key
// is a shortcut the user meant, so Option+arrow and Option+letter stay what they were.
//
//   - A clean press starts the hold at once, so the session opens on the press. With other
//     modifiers already down it was a chord, and nothing starts.
//   - holdBoth starts on the second key, which must go down within altBothWindow of the
//     first, and ends when either comes up.
//   - holdEither runs from the first key down to the last key up, and the other side going
//     down at any time changes nothing. For holdLeft and holdRight the other side is a
//     modifier like any other.
//   - A hold shorter than altHoldMin is discarded at the release.
//
// It only observes: the zero value is ready, and nothing here touches the event stream.
// The Alts' state comes from each event's flags, not from counting edges, so an event lost
// to a full pipe or a disabled tap is corrected by the next one.
type altHold struct {
	mode        holdKeyMode
	left, right bool
	flags       uint64 // as of the last flags event

	phase   holdPhase
	armedAt time.Duration // holdBoth: when the first key went down
	start   time.Duration
}

// SetMode changes which keys make a hold. A hold in progress is discarded.
func (h *altHold) SetMode(m holdKeyMode) []altReport {
	if m == h.mode {
		return nil
	}
	out := h.interrupt("the hold key setting changed")
	h.mode = m
	h.settle()
	return out
}

// Step feeds one event in and says what it meant, in order.
func (h *altHold) Step(ev altEvent) []altReport {
	switch ev.Kind {
	case altEventKeyDown:
		switch h.phase {
		case phaseHolding:
			return h.cancel("a key was pressed during the hold")
		case phaseArming:
			h.phase = phaseWaiting
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
	wasLeft, wasRight := h.left, h.right
	pressed := ev.Flags &^ h.flags & heldModifiers
	pressed |= (ev.Flags ^ h.flags) & flagCapsLock
	h.flags = ev.Flags
	h.left, h.right = ev.Flags&flagLeftAlt != 0, ev.Flags&flagRightAlt != 0
	leftDown, rightDown := h.left && !wasLeft, h.right && !wasRight

	switch h.phase {
	case phaseIdle:
		return h.idle(ev, leftDown, rightDown)
	case phaseArming:
		switch {
		case pressed != 0:
			h.phase = phaseWaiting
		case !h.left && !h.right:
			h.phase = phaseIdle
		case h.left && h.right:
			if ev.At-h.armedAt <= altBothWindow {
				return h.begin(ev.At)
			}
			h.phase = phaseWaiting
		}
	case phaseHolding:
		if !h.triggerDown() {
			return h.release(ev.At)
		}
		if h.mode == holdLeft && rightDown {
			pressed |= flagLeftAlt
		}
		if h.mode == holdRight && leftDown {
			pressed |= flagRightAlt
		}
		if pressed != 0 && ev.At-h.start < altHoldMin {
			return h.cancel(modifierNames(pressed) + " pressed early in the hold")
		}
	}
	if h.phase == phaseWaiting && h.keysUp() {
		h.phase = phaseIdle
	}
	return nil
}

// idle looks for a press. A key that went down with others already held was a chord.
func (h *altHold) idle(ev altEvent, leftDown, rightDown bool) []altReport {
	var candidate, other bool
	switch h.mode {
	case holdLeft:
		candidate, other = leftDown, h.right
	case holdRight:
		candidate, other = rightDown, h.left
	default:
		candidate = leftDown || rightDown
	}
	switch {
	case !candidate:
		if !h.keysUp() {
			h.phase = phaseWaiting
		}
		return nil
	case other || ev.Flags&heldModifiers != 0:
		h.phase = phaseWaiting
		return nil
	case h.mode == holdBoth && !(h.left && h.right):
		h.phase, h.armedAt = phaseArming, ev.At
		return nil
	}
	return h.begin(ev.At)
}

func (h *altHold) begin(at time.Duration) []altReport {
	h.phase, h.start = phaseHolding, at
	return []altReport{{Kind: altReportStarted}}
}

// triggerDown reports whether the keys that make the hold are down.
func (h *altHold) triggerDown() bool {
	switch h.mode {
	case holdLeft:
		return h.left
	case holdRight:
		return h.right
	case holdBoth:
		return h.left && h.right
	}
	return h.left || h.right
}

// keysUp reports whether nothing of a press this mode cares about is still down.
func (h *altHold) keysUp() bool {
	switch h.mode {
	case holdLeft:
		return !h.left
	case holdRight:
		return !h.right
	}
	return !h.left && !h.right
}

func (h *altHold) release(at time.Duration) []altReport {
	h.settle() // holdBoth: the other key may still be on its way up
	held := at - h.start
	if held < altHoldMin {
		return []altReport{{
			Kind: altReportDiscarded,
			Held: held,
			Why:  fmt.Sprintf("held %d ms, under %d ms", held.Milliseconds(), altHoldMin.Milliseconds()),
		}}
	}
	return []altReport{{Kind: altReportCounted, Held: held}}
}

// cancel discards the hold now. The press still has to end before another can start.
func (h *altHold) cancel(why string) []altReport {
	h.phase = phaseWaiting
	return []altReport{{Kind: altReportDiscarded, Why: why}}
}

// interrupt ends whatever was going on: while the tap was off, events went by unseen.
// What is known of the keys stays, so a key still down cannot read as a new press.
func (h *altHold) interrupt(why string) []altReport {
	var out []altReport
	if h.phase == phaseHolding {
		out = []altReport{{Kind: altReportDiscarded, Why: why}}
	}
	h.settle()
	return out
}

// settle leaves a press behind: idle, or waiting for what is still down.
func (h *altHold) settle() {
	h.phase = phaseIdle
	if !h.keysUp() {
		h.phase = phaseWaiting
	}
}

// modifierNames names the modifier bits in bits. flagLeftAlt and flagRightAlt stand for the
// Option key that is not the hold key.
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
		{flagLeftAlt | flagRightAlt, "the other Option"},
	} {
		if bits&m.bit != 0 {
			names = append(names, m.name)
		}
	}
	return strings.Join(names, "+")
}
