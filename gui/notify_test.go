package main

import (
	"bytes"
	"os"
	"slices"
	"testing"
)

func TestBadgeLabel(t *testing.T) {
	tests := []struct {
		count int
		want  string
	}{
		{-1, ""}, {0, ""}, {1, "1"}, {42, "42"}, {99, "99"}, {100, "99+"}, {12345, "99+"},
	}
	for _, tt := range tests {
		if got := badgeLabel(tt.count); got != tt.want {
			t.Errorf("badgeLabel(%d) = %q, want %q", tt.count, got, tt.want)
		}
	}
}

func TestDockBadge(t *testing.T) {
	tests := []struct {
		name  string
		steps []string // a label to set, or "launch"
		want  []string // labels applied, in order
	}{
		{"nothing before launch", []string{"launch"}, nil},
		{"last label before launch is applied at launch", []string{"1", "3", "launch"}, []string{"3"}},
		{"cleared before launch applies nothing", []string{"2", "", "launch"}, nil},
		{"after launch applies each change", []string{"launch", "1", "2", ""}, []string{"1", "2", ""}},
		{"repeats are skipped", []string{"launch", "4", "4", "4"}, []string{"4"}},
		{"a repeat of the pre-launch label is skipped", []string{"5", "launch", "5", "6"}, []string{"5", "6"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			b := &dockBadge{apply: func(l string) { got = append(got, l) }}
			for _, s := range tt.steps {
				if s == "launch" {
					b.didLaunch()
				} else {
					b.set(s)
				}
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("applied %q, want %q", got, tt.want)
			}
		})
	}
}

func TestClampVolume(t *testing.T) {
	tests := []struct{ in, want int }{
		{-5, 0}, {0, 0}, {1, 1}, {50, 50}, {100, 100}, {101, 100}, {1000, 100},
	}
	for _, tt := range tests {
		if got := clampVolume(tt.in); got != tt.want {
			t.Errorf("clampVolume(%d) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

// The embedded alert sound is a PCM WAV NSSound can read (the RIFF/WAVE header), and the
// shipped copy of the design record's soft.wav.
func TestAlertWAV(t *testing.T) {
	if len(alertWAV) < 44 || string(alertWAV[0:4]) != "RIFF" || string(alertWAV[8:12]) != "WAVE" {
		t.Fatalf("alert.wav is not a WAV file (%d bytes)", len(alertWAV))
	}
	design, err := os.ReadFile("../docs/sketches/alert-sound/soft.wav")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(alertWAV, design) {
		t.Error("gui/build/alert.wav differs from docs/sketches/alert-sound/soft.wav")
	}
}
