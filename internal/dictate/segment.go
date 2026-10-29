package dictate

import "time"

// SampleRate is the engine's audio rate (16 kHz mono).
const SampleRate = 16000

// Window is the VAD's frame: Silero scores 512 samples (32 ms) at a time.
const Window = 512

// SegmentConfig tunes phrase segmentation. DefaultSegmentConfig is what the engine uses.
type SegmentConfig struct {
	// Threshold is the speech probability that starts (or keeps) speech.
	Threshold float32
	// NegThreshold is the probability under which a window counts as silence; between
	// the two a window keeps the silence count where it is (hysteresis).
	NegThreshold float32
	// SilenceClose is how much silence closes a phrase.
	SilenceClose time.Duration
	// MaxPhrase cuts a phrase that runs this long; speech goes on in a new phrase.
	MaxPhrase time.Duration
	// MinSpeech is how much speech confirms an onset. Shorter bursts (a click, a cough)
	// raise no speech event and are dropped.
	MinSpeech time.Duration
	// PrePad is the audio kept from before an onset, so the first syllable is whole.
	PrePad time.Duration
	// PostPad is the trailing silence kept after the last speech.
	PostPad time.Duration
}

// DefaultSegmentConfig is the engine's segmentation.
var DefaultSegmentConfig = SegmentConfig{
	Threshold:    0.5,
	NegThreshold: 0.35,
	SilenceClose: 500 * time.Millisecond,
	MaxPhrase:    25 * time.Second,
	MinSpeech:    250 * time.Millisecond,
	PrePad:       200 * time.Millisecond,
	PostPad:      200 * time.Millisecond,
}

// SegKind is what a segmentation step produced.
type SegKind int

const (
	// SegSpeechStart is a confirmed onset.
	SegSpeechStart SegKind = iota
	// SegSpeechEnd is the silence that closed speech (after SilenceClose).
	SegSpeechEnd
	// SegPhrase is audio ready to transcribe.
	SegPhrase
)

// SegEvent is one segmentation step's output. Phrase is set for SegPhrase.
type SegEvent struct {
	Kind   SegKind
	Phrase Phrase
}

// Phrase is a closed span of audio. Times are milliseconds from the session's first
// sample.
type Phrase struct {
	Samples []float32
	StartMS int64
	EndMS   int64
}

// Segmenter turns per-window speech probabilities into phrases. Not safe for concurrent
// use.
type Segmenter struct {
	silenceClose, maxPhrase, minSpeech, prePad, postPad int // in windows
	threshold, negThreshold                             float32

	pos      int64     // windows consumed since Reset
	pre      []float32 // the last PrePad of audio while not in speech
	buf      []float32 // the open phrase, pre-pad included
	start    int64     // the open phrase's first sample
	inSpeech bool
	started  bool // the onset is confirmed (SegSpeechStart sent)
	voiced   int  // speech windows in the open phrase
	silent   int  // consecutive silent windows at the open phrase's end
}

// NewSegmenter returns a segmenter for cfg.
func NewSegmenter(cfg SegmentConfig) *Segmenter {
	w := func(d time.Duration) int {
		n := int(d * SampleRate / time.Second / Window)
		if d > 0 && n == 0 {
			n = 1
		}
		return n
	}
	return &Segmenter{
		silenceClose: w(cfg.SilenceClose),
		maxPhrase:    w(cfg.MaxPhrase),
		minSpeech:    w(cfg.MinSpeech),
		prePad:       w(cfg.PrePad),
		postPad:      w(cfg.PostPad),
		threshold:    cfg.Threshold,
		negThreshold: cfg.NegThreshold,
	}
}

// Reset forgets everything: a new session starts at time zero.
func (s *Segmenter) Reset() {
	*s = Segmenter{
		silenceClose: s.silenceClose, maxPhrase: s.maxPhrase, minSpeech: s.minSpeech,
		prePad: s.prePad, postPad: s.postPad, threshold: s.threshold, negThreshold: s.negThreshold,
	}
}

// InSpeech reports whether a confirmed onset is open.
func (s *Segmenter) InSpeech() bool { return s.inSpeech && s.started }

// Push consumes one window (Window samples) with its speech probability. The window is
// copied.
func (s *Segmenter) Push(window []float32, prob float32) []SegEvent {
	defer func() { s.pos++ }()
	if !s.inSpeech {
		if prob < s.threshold {
			s.pre = append(s.pre, window...)
			if over := len(s.pre) - s.prePad*Window; over > 0 {
				s.pre = append(s.pre[:0], s.pre[over:]...)
			}
			return nil
		}
		s.inSpeech, s.started = true, false
		s.start = s.pos*Window - int64(len(s.pre))
		s.buf = append(append(s.buf[:0], s.pre...), window...)
		s.pre = s.pre[:0]
		s.voiced, s.silent = 1, 0
		return s.confirm(nil)
	}

	s.buf = append(s.buf, window...)
	switch {
	case prob >= s.threshold:
		s.voiced++
		s.silent = 0
	case prob >= s.negThreshold:
		// Between the thresholds: neither speech nor the end of it.
	default:
		s.silent++
	}
	var out []SegEvent
	out = s.confirm(out)
	if s.silent >= s.silenceClose {
		return s.close(out)
	}
	if len(s.buf) >= s.maxPhrase*Window {
		if s.started {
			out = append(out, SegEvent{Kind: SegPhrase, Phrase: s.phrase(s.buf)})
		}
		// Speech goes on: the next phrase starts with the next window.
		s.start = (s.pos + 1) * Window
		s.buf = s.buf[:0]
		s.voiced, s.silent = 0, 0
	}
	return out
}

// Flush closes an open phrase (a session ending): its audio comes out as a phrase if
// the onset was confirmed. The segmenter is then empty.
func (s *Segmenter) Flush() []SegEvent {
	var out []SegEvent
	if s.inSpeech {
		out = s.close(nil)
	}
	s.Reset()
	return out
}

func (s *Segmenter) confirm(out []SegEvent) []SegEvent {
	if !s.started && s.voiced >= s.minSpeech {
		s.started = true
		out = append(out, SegEvent{Kind: SegSpeechStart})
	}
	return out
}

// close ends the open phrase: trailing silence past PostPad is cut, and the phrase and
// the speech edge go out if the onset was confirmed. The silence is kept as the next
// onset's pre-pad.
func (s *Segmenter) close(out []SegEvent) []SegEvent {
	cut := max(0, s.silent-s.postPad) * Window
	audio := s.buf[:len(s.buf)-min(cut, len(s.buf))]
	if s.started {
		out = append(out, SegEvent{Kind: SegSpeechEnd})
		// voiced is 0 when only silence followed a MaxPhrase cut: nothing to transcribe.
		if len(audio) > 0 && s.voiced > 0 {
			out = append(out, SegEvent{Kind: SegPhrase, Phrase: s.phrase(audio)})
		}
	}
	tail := s.buf[max(0, len(s.buf)-s.prePad*Window):]
	s.pre = append(s.pre[:0], tail...)
	s.buf = s.buf[:0]
	s.inSpeech, s.started = false, false
	s.voiced, s.silent = 0, 0
	return out
}

func (s *Segmenter) phrase(audio []float32) Phrase {
	return Phrase{
		Samples: append([]float32(nil), audio...),
		StartMS: s.start * 1000 / SampleRate,
		EndMS:   (s.start + int64(len(audio))) * 1000 / SampleRate,
	}
}
