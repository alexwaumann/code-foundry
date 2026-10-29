// Package dictationtest has fakes for the dictation store: an engine that answers the
// protocol in process with scripted phrases, a launcher that hands them out, and a clock
// that moves only when told.
package dictationtest

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/dictation"
)

// Engine is a fake engine. Its zero value is not usable; NewEngine makes one.
type Engine struct {
	mu     sync.Mutex
	events chan dictation.Event
	done   chan struct{}
	err    error
	closed bool

	// phrases are emitted, in order, by the next end with flush (before its reply).
	phrases  []string
	failLoad error
	loadGate chan struct{}

	enqueued uint64
	calls    []string
	frames   int
	bytes    int
	loaded   bool
	session  string
}

var _ dictation.Engine = (*Engine)(nil)

// NewEngine returns a running fake engine.
func NewEngine() *Engine {
	return &Engine{events: make(chan dictation.Event, 1024), done: make(chan struct{})}
}

// Call implements dictation.Engine.
func (e *Engine) Call(ctx context.Context, method string, params, result any) error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return errors.New("the engine stopped")
	}
	e.calls = append(e.calls, method)
	gate := e.loadGate
	e.mu.Unlock()
	raw, _ := json.Marshal(params)
	switch method {
	case dictation.MethodLoad:
		if gate != nil {
			select {
			case <-gate:
			case <-ctx.Done():
				return ctx.Err()
			case <-e.done:
				return errors.New("the engine stopped")
			}
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.failLoad != nil {
			return e.failLoad
		}
		e.loaded = true
		return setResult(result, dictation.LoadResult{LoadMS: 1200, RSSBytes: 1 << 30})
	case dictation.MethodUnload:
		e.mu.Lock()
		e.loaded = false
		e.mu.Unlock()
	case dictation.MethodBegin:
		var p dictation.SessionParams
		_ = json.Unmarshal(raw, &p)
		e.mu.Lock()
		defer e.mu.Unlock()
		e.session = p.Session
	case dictation.MethodEnd:
		var p dictation.EndParams
		_ = json.Unmarshal(raw, &p)
		e.mu.Lock()
		phrases := e.phrases
		if !p.Flush {
			phrases = nil
		}
		e.phrases, e.session = nil, ""
		e.mu.Unlock()
		for _, t := range phrases {
			e.Emit(dictation.EventPhrase, dictation.PhraseEvent{Session: p.Session, Text: t})
		}
	case dictation.MethodShutdown:
		e.exit(nil)
	}
	return nil
}

func setResult(dst any, v any) error {
	if dst == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

// Notify implements dictation.Engine: audio frames are counted.
func (e *Engine) Notify(method string, params any) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return errors.New("the engine stopped")
	}
	if method == dictation.MethodAudio {
		if p, ok := params.(dictation.AudioParams); ok {
			e.frames++
			e.bytes += len(p.PCM)
		}
	}
	return nil
}

// Events implements dictation.Engine.
func (e *Engine) Events() <-chan dictation.Event { return e.events }

// Done implements dictation.Engine.
func (e *Engine) Done() <-chan struct{} { return e.done }

// Err implements dictation.Engine.
func (e *Engine) Err() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.err
}

// Close implements dictation.Engine.
func (e *Engine) Close() { e.exit(nil) }

// Crash makes the engine exit with err, as if the process died.
func (e *Engine) Crash(err error) { e.exit(err) }

func (e *Engine) exit(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.closed, e.err = true, err
	close(e.events)
	close(e.done)
}

// SetPhrases sets what the next end with flush emits, as the speech the engine held.
func (e *Engine) SetPhrases(texts ...string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.phrases = texts
}

// SetFailLoad makes load fail with err (nil: succeed).
func (e *Engine) SetFailLoad(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.failLoad = err
}

// SetLoadGate holds every load until gate is closed (nil: no hold).
func (e *Engine) SetLoadGate(gate chan struct{}) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.loadGate = gate
}

// Emit sends an event as the engine would.
func (e *Engine) Emit(name string, params any) {
	b, _ := json.Marshal(params)
	e.mu.Lock()
	defer e.mu.Unlock()
	if !e.closed {
		e.enqueued++
		e.events <- dictation.Event{Name: name, Params: b}
	}
}

// Enqueued implements dictation.Engine.
func (e *Engine) Enqueued() uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.enqueued
}

// Speak emits a phrase of the current session framed by its speech edges.
func (e *Engine) Speak(text string) {
	s := e.Session()
	e.Emit(dictation.EventSpeech, dictation.SpeechEvent{Session: s, Active: true})
	e.Emit(dictation.EventPhrase, dictation.PhraseEvent{Session: s, Text: text})
	e.Emit(dictation.EventSpeech, dictation.SpeechEvent{Session: s, Active: false})
}

// Calls are the methods called so far, in order.
func (e *Engine) Calls() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.calls)
}

// Loaded reports whether the model is loaded.
func (e *Engine) Loaded() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.loaded
}

// Session is the session begun and not ended ("" when none).
func (e *Engine) Session() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.session
}

// Frames is how many audio frames, and bytes of them, arrived.
func (e *Engine) Frames() (frames, bytes int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.frames, e.bytes
}

// Exited reports whether the engine has exited.
func (e *Engine) Exited() bool {
	select {
	case <-e.done:
		return true
	default:
		return false
	}
}

// Launcher hands out fake engines.
type Launcher struct {
	mu sync.Mutex
	// Fail are the errors of the next launches, in order (nil entries succeed).
	Fail []error
	setup   func(*Engine)
	engines []*Engine
}

// Launch is a dictation.Launcher.
func (l *Launcher) Launch(context.Context) (dictation.Engine, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.Fail) > 0 {
		err := l.Fail[0]
		l.Fail = l.Fail[1:]
		if err != nil {
			return nil, err
		}
	}
	e := NewEngine()
	if l.setup != nil {
		l.setup(e)
	}
	l.engines = append(l.engines, e)
	return e, nil
}

// SetSetup configures each engine launched from now on before it is returned.
func (l *Launcher) SetSetup(f func(*Engine)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.setup = f
}

// Count is how many engines were launched.
func (l *Launcher) Count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.engines)
}

// Last is the engine launched last (nil before any).
func (l *Launcher) Last() *Engine {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.engines) == 0 {
		return nil
	}
	return l.engines[len(l.engines)-1]
}

// Clock is a fake clock: AfterFunc timers fire only in Advance, in time order, on the
// caller's goroutine.
type Clock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer
}

var _ dictation.Clock = (*Clock)(nil)

// NewClock returns a clock at t.
func NewClock(t time.Time) *Clock { return &Clock{now: t} }

type timer struct {
	c       *Clock
	at      time.Time
	f       func()
	stopped bool
}

// Stop implements dictation.Timer.
func (t *timer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	return true
}

// Now implements dictation.Clock.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc implements dictation.Clock.
func (c *Clock) AfterFunc(d time.Duration, f func()) dictation.Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &timer{c: c, at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return t
}

// Advance moves the clock by d, firing each timer that comes due, in order.
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		sort.SliceStable(c.timers, func(i, j int) bool { return c.timers[i].at.Before(c.timers[j].at) })
		var next *timer
		for i, t := range c.timers {
			if t.stopped {
				continue
			}
			if !t.at.After(end) {
				next = t
				c.timers = append(c.timers[:i:i], c.timers[i+1:]...)
			}
			break
		}
		if next == nil {
			c.now = end
			c.timers = slices.DeleteFunc(c.timers, func(t *timer) bool { return t.stopped })
			c.mu.Unlock()
			return
		}
		next.stopped = true
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

// Pending is how many timers wait to fire.
func (c *Clock) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}

