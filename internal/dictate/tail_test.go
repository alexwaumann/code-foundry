package dictate

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// The windows of a tail: 's' speech, '.' quiet, '~' between the two thresholds.
func TestReleaseTail(t *testing.T) {
	tone := StopToneLength
	tests := []struct {
		name    string
		tone    time.Duration
		windows string
		// decided is how many windows it took; keep how many it kept. 0 and 0: undecided.
		decided, keep int
	}{
		{"quiet from the release", 0, "..........", 9, 9},
		{"a click at the release", 0, "ss.........", 9, 9},
		{"two windows of speech at the end of the base are not talking", 0, ".......ss.", 9, 9},
		{"three are", 0, "......sss.....", 14, 14},
		{"undecided before the base", 0, "ssssssss", 0, 0},
		{"undecided while speech goes on", 0, "ssssssssssssssss", 0, 0},
		{"a syllable's gap is stepped over", 0, "....ss.s......", 14, 14},
		{"two quiet windows are not", 0, "....s..ss.", 9, 9},
		{"quiet ends a growing tail", 0, "ssssssssssss.....", 17, 17},
		{"a gap in the quiet starts it over", 0, "ssssssssss....s...", 18, 18},
		{"the most, still talking", 0, "ssssssssssssssssss", 18, 18},
		{"between the thresholds speech stays speech", 0, "sssssssss~~~.....", 17, 17},
		{"between the thresholds quiet stays quiet", 0, ".....~~~~.", 9, 9},

		{"tone: quiet", tone, "..........", 9, 9},
		{"tone: the tone alone heard as speech, over before the base", tone, "sssss.....", 9, 9},
		{"tone: speech running into the tone's end waits for the decision", tone, "ssssssssss", 0, 0},
		{"tone: quiet after the tone keeps the base", tone, "ssssssssss...", 13, 9},
		{"tone: two windows after it are not enough", tone, "ssssssssssss.", 13, 9},
		{"tone: three windows after it grow the tail", tone, "sssssssssssss.....", 18, 18},
		{"tone: a talker is kept to the most", tone, "ssssssssssssssssss", 18, 18},
		{"a tone too long to hear past is not waited for", time.Second, "ssssssssss", 9, 9},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newReleaseTail(1, tc.tone, DefaultSegmentConfig)
			decided := 0
			for i, w := range strings.Split(tc.windows, "") {
				prob := map[string]float32{"s": 0.9, ".": 0.05, "~": 0.4}[w]
				if r.push(make([]float32, Window), prob) {
					decided = i + 1
					break
				}
			}
			keep, _ := r.through()
			if decided != tc.decided || keep != tc.keep {
				t.Errorf("decided after %d, keeping %d; want %d and %d", decided, keep, tc.decided, tc.keep)
			}
		})
	}
}

func TestReleaseTailBounds(t *testing.T) {
	r := newReleaseTail(1, StopToneLength, DefaultSegmentConfig)
	got := []int{r.base, r.afterTone, r.decision, r.max}
	// 288 ms, 320 ms, 416 ms and 576 ms of audio from the end's arrival.
	if want := []int{9, 10, 13, 18}; !slices.Equal(got, want) {
		t.Errorf("base, afterTone, decision, max = %v, want %v", got, want)
	}
}

func TestReleaseTailKept(t *testing.T) {
	tests := []struct {
		name    string
		windows int
		prob    float32
		want    int
	}{
		{"cut before the base: what arrived", 4, 0.05, 4},
		{"cut while speech grows it: what arrived", 11, 0.9, 11},
		{"decided: the decision", 9, 0.05, 9},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newReleaseTail(1, 0, DefaultSegmentConfig)
			for range tc.windows {
				r.push(make([]float32, Window), tc.prob)
			}
			if got := r.kept(); got != tc.want {
				t.Errorf("kept %d, want %d", got, tc.want)
			}
		})
	}
}
