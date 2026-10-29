package dictate

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

// testSegmentConfig in windows (32 ms each): close after 4 silent windows, cut at 10,
// confirm after 2 voiced, 2 windows of pre-pad, 1 of post-pad.
var testSegmentConfig = SegmentConfig{
	Threshold:    0.5,
	NegThreshold: 0.35,
	SilenceClose: 4 * 32 * time.Millisecond,
	MaxPhrase:    10 * 32 * time.Millisecond,
	MinSpeech:    2 * 32 * time.Millisecond,
	PrePad:       2 * 32 * time.Millisecond,
	PostPad:      1 * 32 * time.Millisecond,
}

// runPattern feeds one window per character ('S' speech 0.9, '.' silence 0.1, '~'
// between the thresholds 0.4; '|' calls Flush). Window i holds the value i in every
// sample, so a phrase names the windows it holds. Events read "start@i", "end@i",
// "phrase a-b@i" (i: the window that produced it, F for Flush).
func runPattern(s *Segmenter, pattern string) []string {
	var out []string
	add := func(at string, evs []SegEvent) {
		for _, ev := range evs {
			switch ev.Kind {
			case SegSpeechStart:
				out = append(out, "start@"+at)
			case SegSpeechEnd:
				out = append(out, "end@"+at)
			case SegPhrase:
				p := ev.Phrase.Samples
				out = append(out, fmt.Sprintf("phrase %d-%d@%s", int(p[0]), int(p[len(p)-1]), at))
			}
		}
	}
	w := 0
	for _, c := range pattern {
		if c == '|' {
			add("F", s.Flush())
			continue
		}
		prob := map[rune]float32{'S': 0.9, '.': 0.1, '~': 0.4}[c]
		win := make([]float32, Window)
		for i := range win {
			win[i] = float32(w)
		}
		add(fmt.Sprint(w), s.Push(win, prob))
		w++
	}
	return out
}

func TestSegmenter(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		want    []string
	}{
		{"silence only", "..........", nil},
		{"one phrase", "..SSSS.....", []string{"start@3", "end@9", "phrase 0-6@9"}},
		{"a click is dropped", "..S......", nil},
		{"pre-pad is bounded", ".....SS....", []string{"start@6", "end@10", "phrase 3-7@10"}},
		{"between the thresholds holds speech", "SS~~SS....", []string{"start@1", "end@9", "phrase 0-6@9"}},
		{"between the thresholds keeps the silence count", "SS..~..", []string{"start@1", "end@6", "phrase 0-3@6"}},
		{"speech resets the silence count", "SS...S....", []string{"start@1", "end@9", "phrase 0-6@9"}},
		{"cut at the max", "SSSSSSSSSSSSSSS....", []string{"start@1", "phrase 0-9@9", "end@18", "phrase 10-15@18"}},
		{"cut then silence", "SSSSSSSSSS....", []string{"start@1", "phrase 0-9@9", "end@13"}},
		{"two phrases, the silence is the next pre-pad", "SS....SS....", []string{"start@1", "end@5", "phrase 0-2@5", "start@7", "end@11", "phrase 4-8@11"}},
		{"flush mid speech", "..SSS|", []string{"start@3", "end@F", "phrase 0-4@F"}},
		{"flush trims the trailing silence", "SSS..|", []string{"start@1", "end@F", "phrase 0-3@F"}},
		{"flush an unconfirmed onset", "..S|", nil},
		{"flush resets time", "SS|SS....", []string{"start@1", "end@F", "phrase 0-1@F", "start@3", "end@7", "phrase 2-4@7"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := runPattern(NewSegmenter(testSegmentConfig), tt.pattern)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("%s\ngot  %q\nwant %q", tt.pattern, got, tt.want)
			}
		})
	}
}

func TestSegmenterTimes(t *testing.T) {
	s := NewSegmenter(testSegmentConfig)
	var phrases []Phrase
	for _, c := range ".....SS...." {
		prob := float32(0.1)
		if c == 'S' {
			prob = 0.9
		}
		for _, ev := range s.Push(make([]float32, Window), prob) {
			if ev.Kind == SegPhrase {
				phrases = append(phrases, ev.Phrase)
			}
		}
	}
	// Windows 3-7 of 32 ms each.
	if len(phrases) != 1 || phrases[0].StartMS != 96 || phrases[0].EndMS != 256 || len(phrases[0].Samples) != 5*Window {
		t.Fatalf("got %+v", phrases)
	}
	if s.InSpeech() {
		t.Fatal("in speech after the phrase closed")
	}
}

func TestDefaultSegmentConfigWindows(t *testing.T) {
	s := NewSegmenter(DefaultSegmentConfig)
	// 500 ms ≈ 15 windows, 25 s ≈ 781, 250 ms ≈ 7, 200 ms ≈ 6.
	if s.silenceClose != 15 || s.maxPhrase != 781 || s.minSpeech != 7 || s.prePad != 6 || s.postPad != 6 {
		t.Fatalf("windows: close %d max %d min %d pre %d post %d", s.silenceClose, s.maxPhrase, s.minSpeech, s.prePad, s.postPad)
	}
}
