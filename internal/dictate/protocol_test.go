package dictate

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestDecodeMessage(t *testing.T) {
	tests := []struct {
		name       string
		line       string
		wantMethod string
		wantID     int64 // -1: a notification
		wantParams string
		wantErr    bool
	}{
		{"request", `{"id":3,"method":"load","params":{"model":"/m.bin","language":"en"}}`, "load", 3, `{"model":"/m.bin","language":"en"}`, false},
		{"request without params", `{"id":0,"method":"status"}`, "status", 0, "", false},
		{"notification", `{"method":"audio","params":{"session":"s","pcm":"AAA="}}`, "audio", -1, `{"session":"s","pcm":"AAA="}`, false},
		{"no method", `{"id":1,"params":{}}`, "", 0, "", true},
		{"not json", `load`, "", 0, "", true},
		{"wrong id type", `{"id":"1","method":"status"}`, "", 0, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m, err := DecodeMessage([]byte(tt.line))
			if tt.wantErr {
				if !errors.Is(err, ErrMalformed) {
					t.Fatalf("err = %v, want ErrMalformed", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.Method != tt.wantMethod || string(m.Params) != tt.wantParams {
				t.Fatalf("got %+v (params %s)", m, m.Params)
			}
			if tt.wantID < 0 {
				if !m.IsNotification() {
					t.Fatalf("id = %d, want a notification", *m.ID)
				}
			} else if m.ID == nil || *m.ID != tt.wantID {
				t.Fatalf("id = %v, want %d", m.ID, tt.wantID)
			}
		})
	}
}

func TestDecoderStream(t *testing.T) {
	in := "{\"id\":1,\"method\":\"status\"}\n\n garbage\n{\"method\":\"audio\"}\n"
	d := NewDecoder(strings.NewReader(in))
	if m, err := d.Next(); err != nil || m.Method != "status" {
		t.Fatalf("1: %+v %v", m, err)
	}
	if _, err := d.Next(); !errors.Is(err, ErrMalformed) {
		t.Fatalf("2: %v, want ErrMalformed (blank lines are skipped)", err)
	}
	if m, err := d.Next(); err != nil || m.Method != "audio" {
		t.Fatalf("3: %+v %v", m, err)
	}
	if _, err := d.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("4: %v, want EOF", err)
	}

	long := NewDecoder(strings.NewReader(strings.Repeat("x", MaxLine+1) + "\n"))
	if _, err := long.Next(); !errors.Is(err, ErrLineTooLong) {
		t.Fatalf("long line: %v", err)
	}
}

func TestEncoder(t *testing.T) {
	tests := []struct {
		name  string
		write func(e *Encoder) error
		want  string
	}{
		{"reply", func(e *Encoder) error { return e.Reply(4, LoadResult{LoadMS: 812, RSSBytes: 1 << 30}) }, `{"id":4,"result":{"load_ms":812,"rss_bytes":1073741824}}`},
		{"empty reply", func(e *Encoder) error { return e.Reply(5, nil) }, `{"id":5,"result":{}}`},
		{"error reply", func(e *Encoder) error { return e.ReplyError(6, errors.New("the model is not loaded")) }, `{"id":6,"error":{"message":"the model is not loaded"}}`},
		{"state", func(e *Encoder) error { return e.Event(EventState, StateEvent{State: StateReady}) }, `{"event":"state","params":{"state":"ready"}}`},
		{"speech", func(e *Encoder) error { return e.Event(EventSpeech, SpeechEvent{Session: "s1", Active: true}) }, `{"event":"speech","params":{"session":"s1","active":true}}`},
		{"phrase", func(e *Encoder) error {
			return e.Event(EventPhrase, PhraseEvent{Session: "s1", Text: "Hi.", StartMS: 320, EndMS: 1200, InferMS: 410})
		}, `{"event":"phrase","params":{"session":"s1","text":"Hi.","start_ms":320,"end_ms":1200,"infer_ms":410}}`},
		{"unloaded", func(e *Encoder) error {
			return e.Event(EventUnloaded, UnloadedEvent{Reason: UnloadReasonMemoryPressure})
		}, `{"event":"unloaded","params":{"reason":"memory-pressure"}}`},
		{"event without params", func(e *Encoder) error { return e.Event(EventError, nil) }, `{"event":"error","params":{}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var b bytes.Buffer
			if err := tt.write(NewEncoder(&b)); err != nil {
				t.Fatal(err)
			}
			if got := b.String(); got != tt.want+"\n" {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

func TestPCM(t *testing.T) {
	tests := []struct {
		name    string
		pcm     []byte
		want    []float32
		wantErr bool
	}{
		{"empty", nil, []float32{}, false},
		{"values", []byte{0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0x7f}, []float32{0, 0.5, -1, 32767.0 / 32768}, false},
		{"odd length", []byte{1, 2, 3}, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DecodePCM(tt.pcm)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			if tt.wantErr {
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("got %v, want %v", got, tt.want)
				}
			}
			if back := EncodePCM(got); !bytes.Equal(back, tt.pcm) && len(tt.pcm) > 0 {
				t.Fatalf("round trip %v, want %v", back, tt.pcm)
			}
		})
	}
	// Out of range floats clamp.
	if got := EncodePCM([]float32{2, -2}); !bytes.Equal(got, []byte{0xff, 0x7f, 0x00, 0x80}) {
		t.Fatalf("clamp: %v", got)
	}
}
