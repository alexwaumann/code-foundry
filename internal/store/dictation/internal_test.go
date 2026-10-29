package dictation

import (
	"testing"
	"time"
)

func TestHardwareOf(t *testing.T) {
	for _, tc := range []struct {
		chip string
		m1   bool
	}{
		{"Apple M1", true},
		{"Apple M1 Pro", true},
		{"Apple M1 Max", true},
		{"Apple M1 Ultra", true},
		{"Apple M2", false},
		{"Apple M4 Pro", false},
		{"Apple M10", false},
		{"", false},
	} {
		if got := HardwareOf(" "+tc.chip+"\n", 8<<30); got.M1Family != tc.m1 || got.Chip != tc.chip || got.MemoryBytes != 8<<30 {
			t.Errorf("HardwareOf(%q) = %+v", tc.chip, got)
		}
	}
}

func TestMeter(t *testing.T) {
	now := time.Unix(0, 0)
	var got []Progress
	m := newMeter(func() time.Time { return now }, 100, 10_000, func(p Progress) { got = append(got, p) })
	// Bytes every 50 ms at 10 KB/s: reported every 250 ms only.
	have := int64(100)
	for range 20 {
		now = now.Add(50 * time.Millisecond)
		have += 500
		m.add(have)
	}
	m.flush(have)
	// The first report, one per 250 ms of the second, and the final one.
	if len(got) != 1+4+1 {
		t.Fatalf("reports %d: %+v", len(got), got)
	}
	if got[0].Received != 100 || got[0].BytesPerSecond != 0 {
		t.Errorf("first %+v", got[0])
	}
	if last := got[len(got)-1]; last.Received != have || last.Total != 10_000 || last.BytesPerSecond != 10_000 {
		t.Errorf("last %+v", last)
	}
}
