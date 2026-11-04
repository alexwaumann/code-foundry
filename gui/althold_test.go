package main

import (
	"bytes"
	"encoding/binary"
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

func TestAltHold(t *testing.T) {
	down := func(s altSide) altReport { return altReport{Kind: altReportDown, Side: s} }
	up := func(s altSide) altReport { return altReport{Kind: altReportUp, Side: s} }
	started := func(s altSide) altReport { return altReport{Kind: altReportStarted, Side: s} }
	counted := func(s altSide, held int) altReport {
		return altReport{Kind: altReportCounted, Side: s, Held: ms(held)}
	}
	discarded := func(why string) altReport { return altReport{Kind: altReportDiscarded, Why: why} }
	short := func(held int, why string) altReport {
		return altReport{Kind: altReportDiscarded, Held: ms(held), Why: why}
	}
	both := altReport{Kind: altReportBoth, Side: altBothSides}
	const l, r = flagLeftAlt, flagRightAlt

	tests := []struct {
		name   string
		events []altEvent
		want   []altReport
	}{
		{
			name:   "left held counts",
			events: []altEvent{flagsAt(0, l), flagsAt(500, 0)},
			want:   []altReport{down(altLeft), started(altLeft), up(altLeft), counted(altLeft, 500)},
		},
		{
			name:   "right held counts",
			events: []altEvent{flagsAt(0, r), flagsAt(500, 0)},
			want:   []altReport{down(altRight), started(altRight), up(altRight), counted(altRight, 500)},
		},
		{
			name:   "exactly the minimum counts",
			events: []altEvent{flagsAt(0, l), flagsAt(300, 0)},
			want:   []altReport{down(altLeft), started(altLeft), up(altLeft), counted(altLeft, 300)},
		},
		{
			name:   "just under the minimum is discarded",
			events: []altEvent{flagsAt(0, l), flagsAt(299, 0)},
			want:   []altReport{down(altLeft), started(altLeft), up(altLeft), short(299, "held 299 ms, under 300 ms")},
		},
		{
			name:   "both within the window count as both, until the last is up",
			events: []altEvent{flagsAt(0, l), flagsAt(80, l|r), flagsAt(400, r), flagsAt(600, 0)},
			want:   []altReport{down(altLeft), started(altLeft), down(altRight), both, up(altLeft), up(altRight), counted(altBothSides, 600)},
		},
		{
			name:   "the other Alt after the window is another key",
			events: []altEvent{flagsAt(0, l), flagsAt(81, l|r), flagsAt(400, r), flagsAt(600, 0)},
			want: []altReport{
				down(altLeft), started(altLeft), down(altRight),
				discarded("right Alt went down 81 ms into the hold"),
				up(altLeft), up(altRight),
			},
		},
		{
			name:   "a side pressed again during both is another key",
			events: []altEvent{flagsAt(0, l), flagsAt(50, l|r), flagsAt(100, r), flagsAt(120, l|r), flagsAt(500, 0)},
			want: []altReport{
				down(altLeft), started(altLeft), down(altRight), both, up(altLeft), down(altLeft),
				discarded("left Alt went down 120 ms into the hold"),
				up(altLeft), up(altRight),
			},
		},
		{
			name:   "a key during the hold discards it once, however long it goes on",
			events: []altEvent{flagsAt(0, l), keyAt(100, 123), keyAt(200, 123), flagsAt(900, 0)},
			want:   []altReport{down(altLeft), started(altLeft), discarded("key 123 pressed during the hold"), up(altLeft)},
		},
		{
			name:   "a modifier during the hold discards it",
			events: []altEvent{flagsAt(0, l), flagsAt(100, l|flagCommand), flagsAt(200, l), flagsAt(900, 0)},
			want:   []altReport{down(altLeft), started(altLeft), discarded("Command pressed during the hold"), up(altLeft)},
		},
		{
			name:   "Caps Lock turned off during the hold discards it",
			events: []altEvent{flagsAt(0, flagCapsLock), flagsAt(10, flagCapsLock|l), flagsAt(100, l), flagsAt(900, 0)},
			want:   []altReport{down(altLeft), started(altLeft), discarded("Caps Lock pressed during the hold"), up(altLeft)},
		},
		{
			name:   "Caps Lock left on does not matter",
			events: []altEvent{flagsAt(0, flagCapsLock), flagsAt(10, flagCapsLock|l), flagsAt(510, flagCapsLock)},
			want:   []altReport{down(altLeft), started(altLeft), up(altLeft), counted(altLeft, 500)},
		},
		{
			name:   "Alt pressed on top of another modifier is not alone",
			events: []altEvent{flagsAt(0, flagShift), flagsAt(10, flagShift|l), flagsAt(20, l), flagsAt(900, 0)},
			want:   []altReport{down(altLeft), discarded("pressed with Shift"), up(altLeft)},
		},
		{
			name:   "keys and modifiers outside a hold say nothing",
			events: []altEvent{keyAt(0, 0), flagsAt(10, flagCommand), keyAt(20, 9), flagsAt(30, 0)},
		},
		{
			name:   "a spoiled hold does not spoil the next",
			events: []altEvent{flagsAt(0, l), keyAt(10, 1), flagsAt(20, 0), flagsAt(100, r), flagsAt(500, 0)},
			want: []altReport{
				down(altLeft), started(altLeft), discarded("key 1 pressed during the hold"), up(altLeft),
				down(altRight), started(altRight), up(altRight), counted(altRight, 400),
			},
		},
		{
			name: "a tap disabled during a hold ends it, and a late release says only that",
			events: []altEvent{
				flagsAt(0, l),
				{Kind: altEventDisabledByTimeout, At: ms(100)},
				flagsAt(900, 0),
			},
			want: []altReport{down(altLeft), started(altLeft), discarded("macOS disabled the tap (timeout)")},
		},
		{
			name:   "a tap disabled with no hold says nothing",
			events: []altEvent{{Kind: altEventDisabledByUserInput, At: ms(100)}},
		},
		{
			name:   "a lost release is corrected by the next flags",
			events: []altEvent{flagsAt(0, l), flagsAt(600, r), flagsAt(1200, 0)},
			want: []altReport{
				down(altLeft), started(altLeft), up(altLeft), counted(altLeft, 600),
				down(altRight), started(altRight), up(altRight), counted(altRight, 600),
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var h altHold
			var got []altReport
			for _, ev := range tt.events {
				got = append(got, h.Step(ev)...)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("reports\n got %+v\nwant %+v", got, tt.want)
			}
		})
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
