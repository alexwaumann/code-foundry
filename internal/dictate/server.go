package dictate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"
)

// PromptTail is how much of the previous phrase primes the next one.
const PromptTail = 200

// minWhisperSamples pads phrases shorter than a second with silence: whisper.cpp skips
// input under 100 ms and is unreliable on very short clips.
const minWhisperSamples = SampleRate

// Backend is the model: whisper and Silero VAD. Its methods are called from one
// goroutine (the server's loop).
type Backend interface {
	// Load loads the whisper model at path (and the VAD) and warms it up.
	Load(path string) error
	// Unload frees both models. A no-op when nothing is loaded.
	Unload()
	// Loaded reports whether Load succeeded since the last Unload.
	Loaded() bool
	// ResetVAD clears the VAD's streaming state (a new session).
	ResetVAD()
	// VAD scores len(samples)/Window windows (len is a multiple of Window), carrying the
	// VAD's state across calls.
	VAD(samples []float32) ([]float32, error)
	// Transcribe runs whisper once over a phrase, primed with prompt.
	Transcribe(samples []float32, prompt string) (string, error)
	// RSS is the process's memory footprint in bytes.
	RSS() uint64
}

// Pressure is a macOS memory-pressure level.
type Pressure int

const (
	// PressureWarn unloads the model once no session is open.
	PressureWarn Pressure = iota + 1
	// PressureCritical unloads it at once, ending an open session.
	PressureCritical
)

// Server runs the protocol over a Backend.
type Server struct {
	backend Backend
	enc     *Encoder
	log     *slog.Logger
	seg     *Segmenter
	// emit sends an event; tests and --transcribe replace it.
	emit func(name string, params any)

	state     string
	session   string
	pending   []float32 // audio short of a whole VAD window
	prompt    string    // the previous phrase's tail
	unloadDue bool      // a memory-pressure warning arrived while listening
}

// NewServer writes replies and events to out.
func NewServer(backend Backend, out io.Writer, log *slog.Logger) *Server {
	s := &Server{
		backend: backend,
		enc:     NewEncoder(out),
		log:     log,
		seg:     NewSegmenter(DefaultSegmentConfig),
		state:   StateIdle,
	}
	s.emit = func(name string, params any) {
		if err := s.enc.Event(name, params); err != nil {
			s.log.Warn("dictate: write event", "event", name, "err", err)
		}
	}
	return s
}

// inboxItem is one thing for the loop to handle, in arrival order.
type inboxItem struct {
	msg      Message
	err      error // a malformed line (msg unset), or fatal with done
	done     bool  // the input ended (err: why, nil at EOF)
	pressure Pressure
}

// inbox is an unbounded FIFO: the stdin reader never blocks on the loop, so the daemon
// can keep writing audio while whisper runs on a phrase.
type inbox struct {
	mu    sync.Mutex
	items []inboxItem
	wake  chan struct{}
}

func newInbox() *inbox { return &inbox{wake: make(chan struct{}, 1)} }

func (q *inbox) push(it inboxItem) {
	q.mu.Lock()
	q.items = append(q.items, it)
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *inbox) pop(ctx context.Context) (inboxItem, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			it := q.items[0]
			q.items[0] = inboxItem{}
			q.items = q.items[1:]
			q.mu.Unlock()
			return it, true
		}
		q.mu.Unlock()
		select {
		case <-q.wake:
		case <-ctx.Done():
			return inboxItem{}, false
		}
	}
}

// Serve reads messages from in until shutdown, EOF or ctx ends, and handles them one at
// a time. pressure (may be nil) delivers memory-pressure notifications. It returns nil
// on shutdown and EOF.
func (s *Server) Serve(ctx context.Context, in io.Reader, pressure <-chan Pressure) error {
	q := newInbox()
	go func() {
		dec := NewDecoder(in)
		for {
			m, err := dec.Next()
			switch {
			case err == nil:
				q.push(inboxItem{msg: m})
			case errors.Is(err, io.EOF):
				q.push(inboxItem{done: true})
				return
			case errors.Is(err, ErrMalformed):
				q.push(inboxItem{err: err})
			default:
				q.push(inboxItem{done: true, err: err})
				return
			}
		}
	}()
	if pressure != nil {
		go func() {
			for {
				select {
				case p, ok := <-pressure:
					if !ok {
						return
					}
					q.push(inboxItem{pressure: p})
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	defer s.backend.Unload()
	s.emit(EventState, StateEvent{State: s.state})
	for {
		it, ok := q.pop(ctx)
		switch {
		case !ok:
			return ctx.Err()
		case it.done:
			return it.err
		case it.pressure != 0:
			s.onPressure(it.pressure)
		case it.err != nil:
			s.emit(EventError, ErrorEvent{Message: it.err.Error()})
		default:
			if s.handle(it.msg) {
				return nil
			}
		}
	}
}

// handle runs one message and reports whether the engine should exit.
func (s *Server) handle(m Message) (exit bool) {
	if m.Method == MethodAudio {
		var p AudioParams
		if err := json.Unmarshal(m.Params, &p); err != nil {
			s.emit(EventError, ErrorEvent{Message: fmt.Sprintf("audio: %v", err)})
			return false
		}
		s.audio(p)
		return false
	}
	if m.IsNotification() {
		s.emit(EventError, ErrorEvent{Message: fmt.Sprintf("%s is a request: it needs an id", m.Method)})
		return false
	}
	result, err := s.call(m)
	if err != nil {
		_ = s.enc.ReplyError(*m.ID, err)
	} else {
		_ = s.enc.Reply(*m.ID, result)
	}
	return err == nil && m.Method == MethodShutdown
}

func (s *Server) call(m Message) (any, error) {
	switch m.Method {
	case MethodLoad:
		var p LoadParams
		if err := unmarshalParams(m.Params, &p); err != nil {
			return nil, err
		}
		return s.load(p)
	case MethodUnload:
		s.unload()
		return nil, nil
	case MethodBegin:
		var p BeginParams
		if err := unmarshalParams(m.Params, &p); err != nil {
			return nil, err
		}
		return nil, s.begin(p)
	case MethodEnd:
		var p EndParams
		if err := unmarshalParams(m.Params, &p); err != nil {
			return nil, err
		}
		s.end(p)
		return nil, nil
	case MethodStatus:
		return StatusResult{State: s.state, ModelLoaded: s.backend.Loaded(), RSSBytes: s.backend.RSS()}, nil
	case MethodShutdown:
		s.closeSession(false)
		return nil, nil
	}
	return nil, fmt.Errorf("unknown method %q", m.Method)
}

func unmarshalParams(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("bad params: %w", err)
	}
	return nil
}

func (s *Server) setState(st string) {
	if s.state == st {
		return
	}
	s.state = st
	s.emit(EventState, StateEvent{State: st})
}

func (s *Server) idleState() string {
	switch {
	case s.session != "":
		return StateListening
	case s.backend.Loaded():
		return StateReady
	}
	return StateIdle
}

func (s *Server) load(p LoadParams) (LoadResult, error) {
	if p.Language != "" && p.Language != Language {
		return LoadResult{}, fmt.Errorf("language %q is not supported (only %q)", p.Language, Language)
	}
	if p.Model == "" {
		return LoadResult{}, errors.New("load needs a model path")
	}
	start := time.Now()
	if !s.backend.Loaded() {
		s.setState(StateLoading)
		err := s.backend.Load(p.Model)
		s.setState(s.idleState())
		if err != nil {
			return LoadResult{}, err
		}
	}
	s.unloadDue = false
	return LoadResult{LoadMS: time.Since(start).Milliseconds(), RSSBytes: s.backend.RSS()}, nil
}

func (s *Server) unload() {
	s.closeSession(false)
	s.backend.Unload()
	s.unloadDue = false
	s.setState(StateIdle)
}

func (s *Server) begin(p BeginParams) error {
	if p.Session == "" {
		return errors.New("begin needs a session")
	}
	if !s.backend.Loaded() {
		return errors.New("the model is not loaded")
	}
	s.closeSession(false)
	s.session = p.Session
	s.seg.Reset()
	s.backend.ResetVAD()
	s.pending = s.pending[:0]
	s.prompt = ""
	s.setState(StateListening)
	return nil
}

func (s *Server) end(p EndParams) {
	if p.Session == "" || p.Session != s.session {
		return // ended already (or never began): end is idempotent
	}
	s.closeSession(p.Flush)
	if s.unloadDue {
		s.pressureUnload()
	}
}

// closeSession ends the open session, if any. With flush the audio still pending is
// scored and the open phrase transcribed (its phrase event goes out first).
func (s *Server) closeSession(flush bool) {
	if s.session == "" {
		return
	}
	if flush {
		if n := len(s.pending); n > 0 {
			// The VAD pads a partial window with zeros; so does the phrase.
			s.pending = append(s.pending, make([]float32, Window-n)...)
			s.score()
		}
		s.handleSeg(s.seg.Flush())
	} else if s.seg.InSpeech() {
		s.emit(EventSpeech, SpeechEvent{Session: s.session, Active: false})
	}
	s.seg.Reset()
	s.pending = s.pending[:0]
	s.prompt = ""
	s.session = ""
	s.setState(s.idleState())
}

func (s *Server) audio(p AudioParams) {
	if p.Session == "" || p.Session != s.session {
		s.log.Debug("dictate: audio for a session that is not open", "session", p.Session)
		return
	}
	samples, err := DecodePCM(p.PCM)
	if err != nil {
		s.emit(EventError, ErrorEvent{Message: err.Error()})
		return
	}
	s.pending = append(s.pending, samples...)
	s.score()
}

// score runs the VAD over the whole windows pending and feeds the segmenter.
func (s *Server) score() {
	n := len(s.pending) / Window * Window
	if n == 0 {
		return
	}
	probs, err := s.backend.VAD(s.pending[:n])
	if err != nil {
		s.emit(EventError, ErrorEvent{Message: fmt.Sprintf("vad: %v", err)})
		probs = nil
	}
	for i := 0; i*Window < n; i++ {
		var p float32
		if i < len(probs) {
			p = probs[i]
		}
		s.handleSeg(s.seg.Push(s.pending[i*Window:(i+1)*Window], p))
	}
	s.pending = append(s.pending[:0], s.pending[n:]...)
}

func (s *Server) handleSeg(evs []SegEvent) {
	for _, ev := range evs {
		switch ev.Kind {
		case SegSpeechStart:
			s.emit(EventSpeech, SpeechEvent{Session: s.session, Active: true})
		case SegSpeechEnd:
			s.emit(EventSpeech, SpeechEvent{Session: s.session, Active: false})
		case SegPhrase:
			s.transcribe(ev.Phrase)
		}
	}
}

func (s *Server) transcribe(ph Phrase) {
	audio := ph.Samples
	if len(audio) < minWhisperSamples {
		audio = append(audio, make([]float32, minWhisperSamples-len(audio))...)
	}
	s.setState(StateTranscribing)
	start := time.Now()
	raw, err := s.backend.Transcribe(audio, s.prompt)
	infer := time.Since(start).Milliseconds()
	s.setState(StateListening)
	if err != nil {
		s.emit(EventError, ErrorEvent{Message: fmt.Sprintf("transcribe: %v", err)})
		return
	}
	text := CleanPhrase(raw)
	s.log.Debug("dictate: phrase", "raw", raw, "text", text, "infer_ms", infer, "audio_ms", ph.EndMS-ph.StartMS)
	if text == "" {
		return
	}
	s.prompt = promptTail(text, PromptTail)
	s.emit(EventPhrase, PhraseEvent{Session: s.session, Text: text, StartMS: ph.StartMS, EndMS: ph.EndMS, InferMS: infer})
}

func (s *Server) onPressure(p Pressure) {
	if !s.backend.Loaded() {
		return
	}
	if p == PressureWarn && s.session != "" {
		s.log.Info("dictate: memory pressure warning; unloading when the session ends")
		s.unloadDue = true
		return
	}
	s.closeSession(false)
	s.pressureUnload()
}

func (s *Server) pressureUnload() {
	s.log.Info("dictate: unloading the model under memory pressure")
	s.backend.Unload()
	s.unloadDue = false
	s.setState(StateIdle)
	s.emit(EventUnloaded, UnloadedEvent{Reason: UnloadReasonMemoryPressure})
}

// TranscribeSamples runs a whole recording through the same path as a session (VAD,
// segmentation, whisper, filters) and calls phrase for each phrase. The model must be
// loaded.
func (s *Server) TranscribeSamples(samples []float32, phrase func(PhraseEvent)) error {
	emit := s.emit
	defer func() { s.emit = emit }()
	var errs []error
	s.emit = func(name string, params any) {
		switch v := params.(type) {
		case PhraseEvent:
			phrase(v)
		case ErrorEvent:
			errs = append(errs, errors.New(v.Message))
		}
	}
	if err := s.begin(BeginParams{Session: "transcribe"}); err != nil {
		return err
	}
	// 100 ms at a time, like the host's frames.
	for len(samples) > 0 {
		n := min(len(samples), SampleRate/10)
		s.pending = append(s.pending, samples[:n]...)
		s.score()
		samples = samples[n:]
	}
	s.closeSession(true)
	return errors.Join(errs...)
}
