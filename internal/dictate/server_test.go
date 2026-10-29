package dictate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBackend scores a window as speech when its first sample is loud, and transcribes
// phrases from a script.
type fakeBackend struct {
	loaded  bool
	texts   []string // returned by Transcribe in order ("" once it runs out)
	prompts []string // what each Transcribe was primed with
	lengths []int    // each phrase's samples (padding included)
	unloads int
	loadErr error
}

func (f *fakeBackend) Load(path string) error {
	if f.loadErr != nil {
		return f.loadErr
	}
	f.loaded = true
	return nil
}
func (f *fakeBackend) Unload() {
	if f.loaded {
		f.unloads++
	}
	f.loaded = false
}
func (f *fakeBackend) Loaded() bool { return f.loaded }
func (f *fakeBackend) ResetVAD()    {}
func (f *fakeBackend) VAD(samples []float32) ([]float32, error) {
	probs := make([]float32, len(samples)/Window)
	for i := range probs {
		if samples[i*Window] > 0.25 {
			probs[i] = 0.9
		} else {
			probs[i] = 0.05
		}
	}
	return probs, nil
}
func (f *fakeBackend) Transcribe(samples []float32, prompt string) (string, error) {
	f.prompts = append(f.prompts, prompt)
	f.lengths = append(f.lengths, len(samples))
	if len(f.texts) == 0 {
		return "", nil
	}
	t := f.texts[0]
	f.texts = f.texts[1:]
	if t == "!fail" {
		return "", errors.New("metal went away")
	}
	return t, nil
}
func (f *fakeBackend) RSS() uint64 { return 1000 }

// A step is a protocol line or a memory-pressure notification.
type step struct {
	line     string
	pressure Pressure
}

func req(id int, method string, params any) step {
	if params == nil {
		return step{line: fmt.Sprintf(`{"id":%d,"method":%q}`, id, method)}
	}
	b, _ := json.Marshal(params)
	return step{line: fmt.Sprintf(`{"id":%d,"method":%q,"params":%s}`, id, method, b)}
}

// audio sends ms of speech (loud) or silence in 100 ms frames.
func audio(session string, ms int, loud bool) []step {
	var out []step
	for ; ms > 0; ms -= 100 {
		n := SampleRate * min(ms, 100) / 1000
		s := make([]float32, n)
		if loud {
			for i := range s {
				s[i] = 0.5
			}
		}
		b, _ := json.Marshal(AudioParams{Session: session, PCM: EncodePCM(s)})
		out = append(out, step{line: fmt.Sprintf(`{"method":"audio","params":%s}`, b)})
	}
	return out
}

func steps(parts ...any) []step {
	var out []step
	for _, p := range parts {
		switch v := p.(type) {
		case step:
			out = append(out, v)
		case []step:
			out = append(out, v...)
		}
	}
	return out
}

var timing = regexp.MustCompile(`"(load|infer)_ms":\d+`)

func runSteps(t *testing.T, f *fakeBackend, ss []step) []string {
	t.Helper()
	var out bytes.Buffer
	s := NewServer(f, &out, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, st := range ss {
		if st.pressure != 0 {
			s.onPressure(st.pressure)
			continue
		}
		m, err := DecodeMessage([]byte(st.line))
		if err != nil {
			t.Fatalf("bad step %s: %v", st.line, err)
		}
		s.handle(m)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	for i, l := range lines {
		lines[i] = timing.ReplaceAllString(l, `"${1}_ms":0`)
	}
	return lines
}

const (
	evLoading      = `{"event":"state","params":{"state":"loading"}}`
	evReady        = `{"event":"state","params":{"state":"ready"}}`
	evIdle         = `{"event":"state","params":{"state":"idle"}}`
	evListening    = `{"event":"state","params":{"state":"listening"}}`
	evTranscribing = `{"event":"state","params":{"state":"transcribing"}}`
	evSpeechOn     = `{"event":"speech","params":{"session":"s","active":true}}`
	evSpeechOff    = `{"event":"speech","params":{"session":"s","active":false}}`
	evUnloaded     = `{"event":"unloaded","params":{"reason":"memory-pressure"}}`
)

func ok(id int) string { return fmt.Sprintf(`{"id":%d,"result":{}}`, id) }

var (
	load    = req(1, MethodLoad, LoadParams{Model: "/m.bin", Language: "en"})
	loaded  = []string{evLoading, evReady, `{"id":1,"result":{"load_ms":0,"rss_bytes":1000}}`}
	begin   = req(2, MethodBegin, BeginParams{Session: "s"})
	begun   = []string{evListening, ok(2)}
	endF    = req(3, MethodEnd, EndParams{Session: "s", Flush: true})
	endNoF  = req(3, MethodEnd, EndParams{Session: "s"})
	ended   = []string{evReady, ok(3)}
	speech  = audio("s", 1000, true)
	silence = audio("s", 700, false)
)

func cat(parts ...[]string) []string { return slices.Concat(parts...) }

func TestServer(t *testing.T) {
	tests := []struct {
		name        string
		texts       []string
		loadErr     error
		steps       []step
		want        []string
		wantPrompts []string
	}{
		{
			name:  "a phrase closes on silence",
			texts: []string{"Hello there."},
			steps: steps(load, begin, speech, silence, endF),
			want: cat(loaded, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"Hello there.","start_ms":0,"end_ms":1216,"infer_ms":0}}`,
			}, ended),
			wantPrompts: []string{""},
		},
		{
			name:  "the previous phrase primes the next",
			texts: []string{"First phrase.", "Second."},
			steps: steps(load, begin, speech, silence, speech, silence),
			want: cat(loaded, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"First phrase.","start_ms":0,"end_ms":1216,"infer_ms":0}}`,
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"Second.","start_ms":1536,"end_ms":2912,"infer_ms":0}}`,
			}),
			wantPrompts: []string{"", "First phrase."},
		},
		{
			name:  "a new session forgets the prompt",
			texts: []string{"One.", "Two."},
			steps: steps(load, begin, speech, silence, endF, begin, speech, silence),
			want: cat(loaded, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"One.","start_ms":0,"end_ms":1216,"infer_ms":0}}`,
			}, ended, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"Two.","start_ms":0,"end_ms":1216,"infer_ms":0}}`,
			}),
			wantPrompts: []string{"", ""},
		},
		{
			name:  "flush transcribes pending speech before the reply",
			texts: []string{"Unfinished"},
			steps: steps(load, begin, speech, endF),
			want: cat(loaded, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"Unfinished","start_ms":0,"end_ms":1024,"infer_ms":0}}`,
			}, ended),
			wantPrompts: []string{""},
		},
		{
			name:        "end without flush drops pending speech",
			texts:       []string{"never"},
			steps:       steps(load, begin, speech, endNoF),
			want:        cat(loaded, begun, []string{evSpeechOn, evSpeechOff}, ended),
			wantPrompts: nil,
		},
		{
			name:        "hallucinations do not land",
			texts:       []string{"Thank you."},
			steps:       steps(load, begin, speech, silence),
			want:        cat(loaded, begun, []string{evSpeechOn, evSpeechOff, evTranscribing, evListening}),
			wantPrompts: []string{""},
		},
		{
			name:  "a failed transcription is an error event",
			texts: []string{"!fail"},
			steps: steps(load, begin, speech, silence),
			want: cat(loaded, begun, []string{evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"error","params":{"message":"transcribe: metal went away"}}`}),
			wantPrompts: []string{""},
		},
		{
			name:  "silence alone transcribes nothing",
			steps: steps(load, begin, audio("s", 3000, false), endF),
			want:  cat(loaded, begun, ended),
		},
		{
			name:  "audio for another session is ignored",
			steps: steps(load, begin, audio("other", 1000, true), audio("other", 700, false)),
			want:  cat(loaded, begun),
		},
		{
			name:  "end of another session is a no-op",
			steps: steps(load, begin, req(3, MethodEnd, EndParams{Session: "old"})),
			want:  cat(loaded, begun, []string{ok(3)}),
		},
		{
			name:  "begin replaces an open session",
			steps: steps(load, begin, speech, req(4, MethodBegin, BeginParams{Session: "t"})),
			want:  cat(loaded, begun, []string{evSpeechOn, evSpeechOff, evReady, evListening, ok(4)}),
		},
		{
			name:  "begin needs the model",
			steps: steps(begin),
			want:  []string{`{"id":2,"error":{"message":"the model is not loaded"}}`},
		},
		{
			name:  "load is idempotent",
			steps: steps(load, req(5, MethodLoad, LoadParams{Model: "/m.bin"})),
			want:  cat(loaded, []string{`{"id":5,"result":{"load_ms":0,"rss_bytes":1000}}`}),
		},
		{
			name:    "a failed load",
			loadErr: errors.New("model: no such file"),
			steps:   steps(load),
			want:    []string{evLoading, evIdle, `{"id":1,"error":{"message":"model: no such file"}}`},
		},
		{
			name:  "only English",
			steps: steps(req(1, MethodLoad, LoadParams{Model: "/m.bin", Language: "de"})),
			want:  []string{`{"id":1,"error":{"message":"language \"de\" is not supported (only \"en\")"}}`},
		},
		{
			name:  "status",
			steps: steps(req(7, MethodStatus, nil), load, req(8, MethodStatus, nil)),
			want: cat([]string{`{"id":7,"result":{"state":"idle","model_loaded":false,"rss_bytes":1000}}`}, loaded,
				[]string{`{"id":8,"result":{"state":"ready","model_loaded":true,"rss_bytes":1000}}`}),
		},
		{
			name:  "unload ends the session",
			steps: steps(load, begin, speech, req(9, MethodUnload, nil)),
			want:  cat(loaded, begun, []string{evSpeechOn, evSpeechOff, evReady, evIdle, ok(9)}),
		},
		{
			name:  "unknown method",
			steps: steps(req(9, "transcribe", nil)),
			want:  []string{`{"id":9,"error":{"message":"unknown method \"transcribe\""}}`},
		},
		{
			name:  "a request without an id",
			steps: steps(step{line: `{"method":"status"}`}),
			want:  []string{`{"event":"error","params":{"message":"status is a request: it needs an id"}}`},
		},
		{
			name:  "bad params",
			steps: steps(step{line: `{"id":1,"method":"load","params":{"model":3}}`}),
			want:  []string{`{"id":1,"error":{"message":"bad params: json: cannot unmarshal number into Go struct field LoadParams.model of type string"}}`},
		},
		{
			name:  "memory pressure unloads a ready engine",
			steps: steps(load, step{pressure: PressureWarn}),
			want:  cat(loaded, []string{evIdle, evUnloaded}),
		},
		{
			name:  "a warning while listening waits for the session to end",
			texts: []string{"Kept."},
			steps: steps(load, begin, speech, step{pressure: PressureWarn}, silence, endF),
			want: cat(loaded, begun, []string{
				evSpeechOn, evSpeechOff, evTranscribing, evListening,
				`{"event":"phrase","params":{"session":"s","text":"Kept.","start_ms":0,"end_ms":1216,"infer_ms":0}}`,
				evReady, evIdle, evUnloaded, ok(3),
			}),
			wantPrompts: []string{""},
		},
		{
			name:  "critical pressure ends the session at once",
			steps: steps(load, begin, speech, step{pressure: PressureCritical}),
			want:  cat(loaded, begun, []string{evSpeechOn, evSpeechOff, evReady, evIdle, evUnloaded}),
		},
		{
			name:  "pressure without a model is ignored",
			steps: steps(step{pressure: PressureCritical}),
			want:  []string{""},
		},
		{
			name:  "a reload after pressure clears the deferred unload",
			steps: steps(load, begin, step{pressure: PressureWarn}, req(9, MethodUnload, nil), load, begin, endNoF),
			want:  cat(loaded, begun, []string{evReady, evIdle, ok(9)}, loaded, begun, ended),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &fakeBackend{texts: tt.texts, loadErr: tt.loadErr}
			got := runSteps(t, f, tt.steps)
			if !slices.Equal(got, tt.want) {
				t.Fatalf("got\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(tt.want, "\n  "))
			}
			if !slices.Equal(f.prompts, tt.wantPrompts) {
				t.Fatalf("prompts %q, want %q", f.prompts, tt.wantPrompts)
			}
		})
	}
}

func TestServerPadsShortPhrases(t *testing.T) {
	f := &fakeBackend{texts: []string{"Hi."}}
	runSteps(t, f, steps(load, begin, audio("s", 300, true), silence))
	if len(f.lengths) != 1 || f.lengths[0] != minWhisperSamples {
		t.Fatalf("lengths %v, want one of %d", f.lengths, minWhisperSamples)
	}
}

func TestServe(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    []string
		wantErr error
	}{
		{
			name: "shutdown stops reading",
			in:   "{\"id\":1,\"method\":\"shutdown\"}\n{\"id\":2,\"method\":\"status\"}\n",
			want: []string{evIdle, ok(1)},
		},
		{
			name: "EOF ends quietly",
			in:   "{\"id\":1,\"method\":\"status\"}\n",
			want: []string{evIdle, `{"id":1,"result":{"state":"idle","model_loaded":false,"rss_bytes":1000}}`},
		},
		{
			name: "a malformed line is reported and skipped",
			in:   "nope\n{\"id\":1,\"method\":\"shutdown\"}\n",
			want: []string{evIdle, `{"event":"error","params":{"message":"dictate: malformed message: invalid character 'o' in literal null (expecting 'u')"}}`, ok(1)},
		},
		{
			name:    "an overlong line is fatal",
			in:      strings.Repeat("x", MaxLine+1),
			want:    []string{evIdle},
			wantErr: ErrLineTooLong,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out bytes.Buffer
			f := &fakeBackend{}
			s := NewServer(f, &out, slog.New(slog.NewTextHandler(io.Discard, nil)))
			err := s.Serve(context.Background(), strings.NewReader(tt.in), nil)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if got := strings.Split(strings.TrimSpace(out.String()), "\n"); !slices.Equal(got, tt.want) {
				t.Fatalf("got\n  %s\nwant\n  %s", strings.Join(got, "\n  "), strings.Join(tt.want, "\n  "))
			}
		})
	}
}

func TestServePressureAndUnloadOnExit(t *testing.T) {
	inR, inW := io.Pipe()
	var out syncBuffer
	f := &fakeBackend{}
	pressure := make(chan Pressure, 1)
	s := NewServer(f, &out, slog.New(slog.NewTextHandler(io.Discard, nil)))
	done := make(chan error, 1)
	go func() { done <- s.Serve(context.Background(), inR, pressure) }()
	_, _ = io.WriteString(inW, load.line+"\n")
	waitFor(t, &out, `"id":1`)
	pressure <- PressureWarn
	waitFor(t, &out, `"unloaded"`)
	_, _ = io.WriteString(inW, load.line+"\n")
	waitFor(t, &out, `{"event":"state","params":{"state":"ready"}}`+"\n"+`{"id":1`)
	_ = inW.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.loaded || f.unloads != 2 {
		t.Fatalf("loaded %v after %d unloads, want unloaded twice (pressure, exit)", f.loaded, f.unloads)
	}
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func waitFor(t *testing.T, b *syncBuffer, s string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(b.String(), s) {
		if time.Now().After(deadline) {
			t.Fatalf("no %q in:\n%s", s, b.String())
		}
		time.Sleep(5 * time.Millisecond)
	}
}
