// Package dictate is the dictation engine behind cmd/code-foundry-dictate: the stdio
// protocol the daemon speaks to it, VAD-driven phrase segmentation, and the filters that
// clean whisper's output. The model itself (whisper.cpp and Silero VAD over cgo) is a
// Backend, implemented by internal/dictate/whisper; everything here is pure Go.
//
// Protocol (newline-delimited JSON over stdin/stdout; docs/notes/dictation-1-engine.md):
//
//	request   {"id":n,"method":m,"params":{...}}   daemon -> engine
//	reply     {"id":n,"result":{...}} | {"id":n,"error":{"message":"..."}}
//	notify    {"method":"audio","params":{...}}    daemon -> engine, no reply
//	event     {"event":e,"params":{...}}           engine -> daemon
package dictate

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// Request methods (daemon -> engine).
const (
	MethodLoad     = "load"
	MethodUnload   = "unload"
	MethodBegin    = "begin"
	MethodEnd      = "end"
	MethodStatus   = "status"
	MethodShutdown = "shutdown"
	// MethodAudio is a notification: no id, no reply.
	MethodAudio = "audio"
)

// Events (engine -> daemon).
const (
	EventState    = "state"
	EventSpeech   = "speech"
	EventPhrase   = "phrase"
	EventUnloaded = "unloaded"
	EventError    = "error"
)

// Engine states, as the state event and the status reply report them.
const (
	StateIdle         = "idle"         // no model loaded
	StateLoading      = "loading"      // a load is in flight
	StateReady        = "ready"        // model resident, no session
	StateListening    = "listening"    // a session is open
	StateTranscribing = "transcribing" // whisper is running on a phrase
)

// UnloadReasonMemoryPressure is the unloaded event's reason after a macOS
// memory-pressure notification.
const UnloadReasonMemoryPressure = "memory-pressure"

// Language is the one language the engine transcribes.
const Language = "en"

// MaxLine bounds one protocol line. An audio notification of a second of audio is about
// 43 KB of base64; a longer line is a protocol error.
const MaxLine = 4 << 20

// Message is one decoded line from the daemon: a request (ID set) or a notification.
type Message struct {
	ID     *int64          `json:"id,omitempty"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// IsNotification reports whether the message expects no reply.
func (m Message) IsNotification() bool { return m.ID == nil }

// LoadParams are load's params.
type LoadParams struct {
	Model    string `json:"model"`
	Language string `json:"language"`
}

// LoadResult is load's result.
type LoadResult struct {
	LoadMS   int64  `json:"load_ms"`
	RSSBytes uint64 `json:"rss_bytes"`
}

// BeginParams are begin's params.
type BeginParams struct {
	Session string `json:"session"`
}

// EndParams are end's params.
type EndParams struct {
	Session string `json:"session"`
	Flush   bool   `json:"flush"`
}

// StatusResult is status's result.
type StatusResult struct {
	State       string `json:"state"`
	ModelLoaded bool   `json:"model_loaded"`
	RSSBytes    uint64 `json:"rss_bytes"`
}

// AudioParams are the audio notification's params. PCM is int16 little-endian, 16 kHz
// mono; encoding/json carries it as standard base64.
type AudioParams struct {
	Session string `json:"session"`
	PCM     []byte `json:"pcm"`
}

// StateEvent is the state event's params.
type StateEvent struct {
	State string `json:"state"`
}

// SpeechEvent is a VAD edge.
type SpeechEvent struct {
	Session string `json:"session"`
	Active  bool   `json:"active"`
}

// PhraseEvent is one transcribed phrase. Times are milliseconds from the session's first
// sample.
type PhraseEvent struct {
	Session string `json:"session"`
	Text    string `json:"text"`
	StartMS int64  `json:"start_ms"`
	EndMS   int64  `json:"end_ms"`
	InferMS int64  `json:"infer_ms"`
}

// UnloadedEvent says the engine dropped the model on its own.
type UnloadedEvent struct {
	Reason string `json:"reason"`
}

// ErrorEvent is an asynchronous failure (a malformed line, a failed transcription).
type ErrorEvent struct {
	Message string `json:"message"`
}

// ErrorBody is a failed reply's error.
type ErrorBody struct {
	Message string `json:"message"`
}

type replyOK struct {
	ID     int64 `json:"id"`
	Result any   `json:"result"`
}

type replyErr struct {
	ID    int64     `json:"id"`
	Error ErrorBody `json:"error"`
}

type event struct {
	Event  string `json:"event"`
	Params any    `json:"params"`
}

// ErrLineTooLong is returned by Decoder.Next for a line over MaxLine.
var ErrLineTooLong = errors.New("dictate: protocol line too long")

// ErrMalformed wraps a line that is not a message: reported, then skipped.
var ErrMalformed = errors.New("dictate: malformed message")

// Decoder reads messages, one per line.
type Decoder struct {
	sc *bufio.Scanner
}

// NewDecoder reads from r.
func NewDecoder(r io.Reader) *Decoder {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), MaxLine)
	return &Decoder{sc: sc}
}

// Next returns the next message. A line that is not a valid message returns an error
// wrapping ErrMalformed: the caller reports it and goes on. io.EOF ends the stream;
// ErrLineTooLong and read errors are fatal.
func (d *Decoder) Next() (Message, error) {
	for d.sc.Scan() {
		line := d.sc.Bytes()
		if len(line) == 0 {
			continue
		}
		return DecodeMessage(line)
	}
	if err := d.sc.Err(); err != nil {
		if errors.Is(err, bufio.ErrTooLong) {
			return Message{}, ErrLineTooLong
		}
		return Message{}, fmt.Errorf("dictate: read: %w", err)
	}
	return Message{}, io.EOF
}

// DecodeMessage parses one line.
func DecodeMessage(line []byte) (Message, error) {
	var m Message
	if err := json.Unmarshal(line, &m); err != nil {
		return Message{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if m.Method == "" {
		return Message{}, fmt.Errorf("%w: no method", ErrMalformed)
	}
	return m, nil
}

// Encoder writes replies and events, one per line. Safe for concurrent use.
type Encoder struct {
	mu sync.Mutex
	w  io.Writer
}

// NewEncoder writes to w.
func NewEncoder(w io.Writer) *Encoder { return &Encoder{w: w} }

// Reply writes a successful reply; a nil result is sent as {}.
func (e *Encoder) Reply(id int64, result any) error {
	if result == nil {
		result = struct{}{}
	}
	return e.write(replyOK{ID: id, Result: result})
}

// ReplyError writes a failed reply.
func (e *Encoder) ReplyError(id int64, err error) error {
	return e.write(replyErr{ID: id, Error: ErrorBody{Message: err.Error()}})
}

// Event writes an event; nil params are sent as {}.
func (e *Encoder) Event(name string, params any) error {
	if params == nil {
		params = struct{}{}
	}
	return e.write(event{Event: name, Params: params})
}

func (e *Encoder) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("dictate: encode: %w", err)
	}
	b = append(b, '\n')
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, err := e.w.Write(b); err != nil {
		return fmt.Errorf("dictate: write: %w", err)
	}
	return nil
}

// DecodePCM converts int16 little-endian samples to floats in [-1, 1).
func DecodePCM(pcm []byte) ([]float32, error) {
	if len(pcm)%2 != 0 {
		return nil, fmt.Errorf("dictate: pcm has an odd length %d", len(pcm))
	}
	out := make([]float32, len(pcm)/2)
	for i := range out {
		out[i] = float32(int16(binary.LittleEndian.Uint16(pcm[2*i:]))) / 32768
	}
	return out, nil
}

// EncodePCM is DecodePCM's inverse (clamped), for tests and the daemon's fake.
func EncodePCM(samples []float32) []byte {
	out := make([]byte, 2*len(samples))
	for i, s := range samples {
		v := s * 32768
		switch {
		case v > 32767:
			v = 32767
		case v < -32768:
			v = -32768
		}
		binary.LittleEndian.PutUint16(out[2*i:], uint16(int16(v)))
	}
	return out
}
