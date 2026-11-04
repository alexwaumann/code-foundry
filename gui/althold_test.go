package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func ms(n int) time.Duration { return time.Duration(n) * time.Millisecond }

func flagsAt(at int, flags uint64) altEvent {
	return altEvent{Kind: altEventFlags, At: ms(at), Flags: flags}
}

func keyAt(at int, code uint32) altEvent {
	return altEvent{Kind: altEventKeyDown, At: ms(at), KeyCode: code}
}

func TestParseHoldKey(t *testing.T) {
	for in, want := range map[string]holdKeyMode{"left": holdLeft, "right": holdRight, "both": holdBoth, "either": holdBoth, "": holdBoth, "alt": holdBoth} {
		if got := parseHoldKey(in); got != want {
			t.Errorf("parseHoldKey(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestAltHold(t *testing.T) {
	started := altReport{Kind: altReportStarted}
	counted := func(held int) altReport { return altReport{Kind: altReportCounted, Held: ms(held)} }
	discarded := func(why string) altReport { return altReport{Kind: altReportDiscarded, Why: why} }
	short := func(held int) altReport {
		return altReport{Kind: altReportDiscarded, Held: ms(held), Why: fmt.Sprintf("held %d ms, under 300 ms", held)}
	}
	const l, r = flagLeftAlt, flagRightAlt
	const keyWhy = "a key was pressed during the hold"

	tests := []struct {
		name   string
		mode   holdKeyMode
		events []altEvent
		want   []altReport
	}{
		// A plain hold, for each mode.
		{name: "both: left held counts", events: []altEvent{flagsAt(0, l), flagsAt(500, 0)}, want: []altReport{started, counted(500)}},
		{name: "both: right held counts", events: []altEvent{flagsAt(0, r), flagsAt(500, 0)}, want: []altReport{started, counted(500)}},
		{name: "left: left held counts", mode: holdLeft, events: []altEvent{flagsAt(0, l), flagsAt(500, 0)}, want: []altReport{started, counted(500)}},
		{name: "left: right does nothing", mode: holdLeft, events: []altEvent{flagsAt(0, r), flagsAt(500, 0)}},
		{name: "right: right held counts", mode: holdRight, events: []altEvent{flagsAt(0, r), flagsAt(500, 0)}, want: []altReport{started, counted(500)}},
		{name: "right: left does nothing", mode: holdRight, events: []altEvent{flagsAt(0, l), flagsAt(500, 0)}},

		// The 300 ms line.
		{name: "exactly the minimum counts", events: []altEvent{flagsAt(0, l), flagsAt(300, 0)}, want: []altReport{started, counted(300)}},
		{name: "just under the minimum is discarded", events: []altEvent{flagsAt(0, l), flagsAt(299, 0)}, want: []altReport{started, short(299)}},

		// A modifier: only the first 300 ms.
		{
			name:   "a modifier in the first 300 ms cancels",
			events: []altEvent{flagsAt(0, l), flagsAt(299, l|flagShift), flagsAt(500, flagShift), flagsAt(600, 0)},
			want:   []altReport{started, discarded("Shift pressed early in the hold")},
		},
		{
			name:   "a modifier at 300 ms does not",
			events: []altEvent{flagsAt(0, l), flagsAt(300, l|flagShift), flagsAt(900, flagShift), flagsAt(950, 0)},
			want:   []altReport{started, counted(900)},
		},
		{
			name:   "a modifier long after does not",
			events: []altEvent{flagsAt(0, l), flagsAt(15700, l|flagCommand), flagsAt(15800, l), flagsAt(16000, 0)},
			want:   []altReport{started, counted(16000)},
		},
		{
			name:   "Caps Lock turned off early",
			events: []altEvent{flagsAt(0, flagCapsLock), flagsAt(10, flagCapsLock|l), flagsAt(100, l), flagsAt(500, 0)},
			want:   []altReport{started, discarded("Caps Lock pressed early in the hold")},
		},
		{
			name:   "Caps Lock left on is no modifier",
			events: []altEvent{flagsAt(0, flagCapsLock), flagsAt(10, flagCapsLock|l), flagsAt(510, flagCapsLock)},
			want:   []altReport{started, counted(500)},
		},

		// The other Option key.
		{
			name:   "both: the other side early is no cancel, and the hold lasts to the last key up",
			events: []altEvent{flagsAt(0, l), flagsAt(100, l|r), flagsAt(400, r), flagsAt(700, 0)},
			want:   []altReport{started, counted(700)},
		},
		{
			name:   "both: the other side 15.7 s in is no cancel",
			events: []altEvent{flagsAt(0, l), flagsAt(15700, l|r), flagsAt(15900, l), flagsAt(16000, 0)},
			want:   []altReport{started, counted(16000)},
		},
		{
			name: "left: the other side early cancels", mode: holdLeft,
			events: []altEvent{flagsAt(0, l), flagsAt(100, l|r), flagsAt(500, r), flagsAt(600, 0)},
			want:   []altReport{started, discarded("the other Option pressed early in the hold")},
		},
		{
			name: "left: the other side 15.7 s in does not, and only left ends it", mode: holdLeft,
			events: []altEvent{flagsAt(0, l), flagsAt(15700, l|r), flagsAt(15800, r), flagsAt(15900, 0)},
			want:   []altReport{started, counted(15800)},
		},
		{
			name: "right: the other side early cancels", mode: holdRight,
			events: []altEvent{flagsAt(0, r), flagsAt(100, l|r), flagsAt(500, l), flagsAt(600, 0)},
			want:   []altReport{started, discarded("the other Option pressed early in the hold")},
		},
		{
			name: "left: pressed with right already down is a chord", mode: holdLeft,
			events: []altEvent{flagsAt(0, r), flagsAt(100, l|r), flagsAt(900, r), flagsAt(950, 0)},
		},

		// A key that is not a modifier: any time.
		{name: "a key early cancels", events: []altEvent{flagsAt(0, l), keyAt(100, 123), flagsAt(500, 0)}, want: []altReport{started, discarded(keyWhy)}},
		{name: "a key late cancels", events: []altEvent{flagsAt(0, l), keyAt(9000, 14), flagsAt(9500, 0)}, want: []altReport{started, discarded(keyWhy)}},
		{name: "a key before the press is nothing", events: []altEvent{keyAt(0, 14), flagsAt(10, l), flagsAt(510, 0)}, want: []altReport{started, counted(500)}},
		{name: "a key after the release is nothing", events: []altEvent{flagsAt(0, l), flagsAt(500, 0), keyAt(510, 14)}, want: []altReport{started, counted(500)}},
		{name: "two keys cancel once", events: []altEvent{flagsAt(0, l), keyAt(100, 14), keyAt(200, 15), flagsAt(500, 0)}, want: []altReport{started, discarded(keyWhy)}},

		// Chords, and what a cancelled press leaves behind.
		{name: "pressed with a modifier already held starts nothing", events: []altEvent{flagsAt(0, flagControl), flagsAt(100, flagControl|l), flagsAt(600, flagControl), flagsAt(700, 0)}},
		{
			name:   "Option still down after the modifier comes up starts nothing",
			events: []altEvent{flagsAt(0, flagControl), flagsAt(100, flagControl|l), flagsAt(150, l), flagsAt(900, 0)},
		},
		{
			name:   "both: the other side going down in a cancelled press starts nothing",
			events: []altEvent{flagsAt(0, l), keyAt(50, 14), flagsAt(100, l|r), flagsAt(600, r), flagsAt(900, 0)},
			want:   []altReport{started, discarded(keyWhy)},
		},
		{
			name:   "the next press after a cancel is a new hold",
			events: []altEvent{flagsAt(0, l), keyAt(50, 14), flagsAt(100, 0), flagsAt(1000, r), flagsAt(1400, 0)},
			want:   []altReport{started, discarded(keyWhy), started, counted(400)},
		},
		{
			name:   "two holds in a row",
			events: []altEvent{flagsAt(0, l), flagsAt(400, 0), flagsAt(1000, r), flagsAt(1100, 0)},
			want:   []altReport{started, counted(400), started, short(100)},
		},

		// A tap off for a while.
		{
			name:   "disabled by timeout discards the hold",
			events: []altEvent{flagsAt(0, l), {Kind: altEventDisabledByTimeout, At: ms(100)}, flagsAt(900, 0)},
			want:   []altReport{started, discarded("macOS disabled the tap (timeout)")},
		},
		{
			name:   "disabled by user input discards the hold",
			events: []altEvent{flagsAt(0, l), {Kind: altEventDisabledByUserInput, At: ms(100)}},
			want:   []altReport{started, discarded("macOS disabled the tap (user input)")},
		},
		{name: "disabled while idle says nothing", events: []altEvent{{Kind: altEventDisabledByTimeout}}},
		{
			name:   "a key still down after a disabled tap cannot start a hold",
			events: []altEvent{flagsAt(0, l), {Kind: altEventDisabledByTimeout, At: ms(100)}, flagsAt(200, l|r), flagsAt(800, r), flagsAt(900, 0), flagsAt(1000, l), flagsAt(1500, 0)},
			want:   []altReport{started, discarded("macOS disabled the tap (timeout)"), started, counted(500)},
		},
		{
			// A lost release is corrected by the next event's flags.
			name:   "a lost release: the next event ends the hold",
			events: []altEvent{flagsAt(0, l), flagsAt(800, flagShift)},
			want:   []altReport{started, counted(800)},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := altHold{mode: tt.mode}
			var got []altReport
			for _, ev := range tt.events {
				got = append(got, h.Step(ev)...)
			}
			if len(got) == 0 && len(tt.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got  %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestAltHoldSetMode(t *testing.T) {
	var h altHold
	h.Step(flagsAt(0, flagLeftAlt))
	if got := h.SetMode(holdBoth); got != nil {
		t.Errorf("same mode: %+v", got)
	}
	got := h.SetMode(holdRight)
	if len(got) != 1 || got[0].Kind != altReportDiscarded {
		t.Fatalf("a hold in progress: %+v", got)
	}
	// Left is no key of the new mode, so right can start at once.
	if r := h.Step(flagsAt(100, flagLeftAlt|flagRightAlt)); len(r) != 0 {
		t.Errorf("with the old key still down it is a chord: %+v", r)
	}
	h.Step(flagsAt(200, flagLeftAlt))
	h.Step(flagsAt(300, 0))
	if r := h.Step(flagsAt(400, flagRightAlt)); len(r) != 1 || r[0].Kind != altReportStarted {
		t.Errorf("the new key: %+v", r)
	}
}

func TestPumpAltEvents(t *testing.T) {
	record := func(kind, dropped uint32, flags, at uint64, key uint32) []byte {
		b := make([]byte, altRecordSize)
		binary.LittleEndian.PutUint32(b[0:], kind)
		binary.LittleEndian.PutUint32(b[4:], dropped)
		binary.LittleEndian.PutUint64(b[8:], flags)
		binary.LittleEndian.PutUint64(b[16:], at)
		binary.LittleEndian.PutUint32(b[24:], key)
		return b
	}
	in := append(record(0, 0, flagLeftAlt, 1000, 58), record(1, 2, 0, 2000, 9)...)
	in = append(in, 1, 2, 3) // a torn record ends the stream
	out := make(chan altEvent, 4)
	pumpAltEvents(bytes.NewReader(in), out)
	var got []altEvent
	for ev := range out {
		got = append(got, ev)
	}
	want := []altEvent{
		{Kind: altEventFlags, At: 1000, Flags: flagLeftAlt, KeyCode: 58},
		{Kind: altEventKeyDown, At: 2000, KeyCode: 9, Dropped: 2},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("events\n got %+v\nwant %+v", got, want)
	}
}
