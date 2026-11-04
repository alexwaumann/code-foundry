package dictate

import "time"

// The release tail (docs/notes/dictation-release-tail.md): people let go of the hold key
// while the last word is still sounding, so a session ended by a release listens on for a
// moment. It is here because only the engine sees speech window by window; the daemon gets
// edges that lag by hundreds of milliseconds, and the host only a level.
//
// The rules and their numbers are Hex's (release_tail in its dictation.rs), in Silero's 32 ms
// windows instead of its 20 ms frames.
const (
	// ReleaseTail is what a release always keeps.
	ReleaseTail = 200 * time.Millisecond
	// MaxReleaseTail is the most it keeps, speech carrying on past ReleaseTail.
	MaxReleaseTail = 600 * time.Millisecond
	// StopToneLength is how long the hold key's stop tone sounds (gui/build/dictate-stop.wav).
	StopToneLength = 140 * time.Millisecond
	// TailWait is how long a tail waits for its audio before it ends with what it has: a
	// microphone that went away must not hold up the text.
	TailWait = MaxReleaseTail + 100*time.Millisecond

	// captureLag is the audio behind the release when the end arrives: the host's frames
	// come in bursts every 100 ms, so that much of what the tail counts may be from before
	// the release. ReleaseTail is a floor and counts it; MaxReleaseTail is a ceiling and
	// does not need to.
	captureLag = 100 * time.Millisecond
	// toneMargin is how long after its own length the tone may still reach the microphone
	// (output and input latency).
	toneMargin = 60 * time.Millisecond

	// tailSpeech is how many speech windows in a row count as still talking (Hex: 5 of
	// 20 ms); a key click is far shorter.
	tailSpeech = 3
	// tailQuiet is how many quiet windows in a row end a growing tail (Hex: 8 of 20 ms).
	tailQuiet = 5
	// tailGap is how many quiet windows a run of speech may step over, as between
	// syllables (Hex: 2 of 20 ms).
	tailGap = 1
)

// windowsIn is how many whole VAD windows fit in d.
func windowsIn(d time.Duration) int { return int(d * SampleRate / time.Second / Window) }

// releaseTail is one tail: the windows that arrived after the end, held out of the segmenter
// until the tail's length is known, so audio past it never reaches whisper.
type releaseTail struct {
	id int64 // the end request, answered when the session closes

	base, max int // windows always kept, and at most
	// afterTone is the first window the stop tone cannot reach, 0 with no tone. Speech
	// only grows the tail if it is heard from there on.
	afterTone int
	// decision is where it can be told whether speech carries on.
	decision int

	audio  []float32
	probs  []float32
	speech []bool
	// talking is the hysteresis of Silero's two thresholds, as in the segmenter.
	talking             bool
	threshold, negative float32
}

// newReleaseTail starts a tail for the end request id. tone is the stop tone's length, 0 when
// it will not sound.
func newReleaseTail(id int64, tone time.Duration, cfg SegmentConfig) *releaseTail {
	t := &releaseTail{
		id:        id,
		base:      windowsIn(ReleaseTail + captureLag),
		max:       windowsIn(MaxReleaseTail),
		threshold: cfg.Threshold,
		negative:  cfg.NegThreshold,
	}
	if tone > 0 {
		t.afterTone = windowsIn(captureLag+tone+toneMargin) + 1
	}
	t.decision = max(t.base, t.afterTone+tailSpeech)
	return t
}

// push takes the next window and reports whether the tail's length is now known.
func (t *releaseTail) push(window []float32, prob float32) bool {
	t.audio = append(t.audio, window...)
	t.probs = append(t.probs, prob)
	switch {
	case prob >= t.threshold:
		t.talking = true
	case prob < t.negative:
		t.talking = false
	}
	t.speech = append(t.speech, t.talking)
	_, done := t.through()
	return done
}

// through is how many windows to keep, once that is known.
func (t *releaseTail) through() (windows int, done bool) {
	heard := len(t.speech)
	switch {
	case heard < t.base:
		return 0, false
	case !t.talkingUntil(t.base, 0), t.decision > t.max:
		return t.base, true
	case heard < t.decision:
		return 0, false
	case !t.talkingUntil(t.decision, t.afterTone):
		// What ran into the base was the tone, or stopped under it.
		return t.base, true
	}
	if end, ok := t.quietEnd(t.decision, heard); ok {
		return min(end, t.max), true
	}
	if heard >= t.max {
		return t.max, true
	}
	return 0, false
}

// kept is how many windows to keep now, whether or not the length was decided: one cut short
// keeps what arrived.
func (t *releaseTail) kept() int {
	if n, done := t.through(); done {
		return n
	}
	return len(t.speech)
}

// talkingUntil reports whether speech runs up to window end (exclusive): its last speech
// window is within a syllable's gap of end, and tailSpeech speech windows, none before from,
// lead up to it with no longer gap.
func (t *releaseTail) talkingUntil(end, from int) bool {
	speech, gap := 0, 0
	for i := end - 1; i >= from; i-- {
		if t.speech[i] {
			speech++
			gap = 0
			if speech >= tailSpeech {
				return true
			}
			continue
		}
		gap++
		if gap > tailGap {
			return false
		}
	}
	return false
}

// quietEnd is the first window from from, before end, that closes tailQuiet quiet windows in
// a row, as the count of windows through it.
func (t *releaseTail) quietEnd(from, end int) (int, bool) {
	quiet := 0
	for i := from; i < end; i++ {
		if t.speech[i] {
			quiet = 0
			continue
		}
		quiet++
		if quiet == tailQuiet {
			return i + 1, true
		}
	}
	return 0, false
}
