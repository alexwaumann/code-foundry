package whisper

import (
	"io"
	"log/slog"
	"math"
	"testing"
)

// The embedded Silero model loads from memory and scores a stream window by window. (The
// whisper model is too big for a test; docs/notes/dictation-1-engine.md has the manual
// check.)
func TestEmbeddedVAD(t *testing.T) {
	e := Start(slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer e.Close()
	var err error
	e.do(func() { err = e.loadVAD() })
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		samples []float32
		want    int
	}{
		{"silence", make([]float32, 512*10), 10},
		{"a tone", tone(512 * 4), 4},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			probs, err := e.VAD(tt.samples)
			if err != nil {
				t.Fatal(err)
			}
			if len(probs) != tt.want {
				t.Fatalf("%d probabilities, want %d", len(probs), tt.want)
			}
			for _, p := range probs {
				if p < 0 || p > 1 || (tt.name == "silence" && p > 0.2) {
					t.Fatalf("probabilities %v", probs)
				}
			}
		})
	}
	e.ResetVAD()
	if e.Loaded() {
		t.Fatal("Loaded without a whisper model")
	}
	if _, err := e.Transcribe(make([]float32, 16000), ""); err == nil {
		t.Fatal("Transcribe without a model succeeded")
	}
	if e.RSS() == 0 {
		t.Fatal("RSS is 0")
	}
}

func TestLoadMissingModel(t *testing.T) {
	e := Start(slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer e.Close()
	if err := e.Load("/nonexistent/ggml.bin"); err == nil {
		t.Fatal("loaded a missing model")
	}
	e.Close()
	e.Unload() // after Close: a no-op, not a panic
}

func tone(n int) []float32 {
	s := make([]float32, n)
	for i := range s {
		s[i] = float32(0.3 * math.Sin(2*math.Pi*220*float64(i)/16000))
	}
	return s
}
