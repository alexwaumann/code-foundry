package dictation

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/childproc"
)

// The engine protocol (code-foundry-dictate over stdio, newline-delimited JSON): the
// daemon's requests {"id":n,"method":…,"params":…} get {"id":n,"result":…} or
// {"id":n,"error":{"message":…}}; its notifications ({"method":"audio",…}) get nothing;
// the engine's events are {"event":…,"params":…}. docs/notes/dictation-2-daemon.md.

// Requests and notifications (daemon → engine).
const (
	MethodLoad     = "load"
	MethodUnload   = "unload"
	MethodBegin    = "begin"
	MethodEnd      = "end"
	MethodStatus   = "status"
	MethodShutdown = "shutdown"
	MethodAudio    = "audio"
)

// Events (engine → daemon).
const (
	EventState    = "state"
	EventSpeech   = "speech"
	EventPhrase   = "phrase"
	EventUnloaded = "unloaded"
	EventError    = "error"
)

// LoadParams are load's params.
type LoadParams struct {
	Model    string `json:"model"`
	Language string `json:"language"`
}

// LoadResult is load's result.
type LoadResult struct {
	LoadMS   int64 `json:"load_ms"`
	RSSBytes int64 `json:"rss_bytes"`
}

// SessionParams are begin's params.
type SessionParams struct {
	Session string `json:"session"`
}

// EndParams are end's params.
type EndParams struct {
	Session string `json:"session"`
	Flush   bool   `json:"flush"`
}

// AudioParams are the audio notification's params: pcm is base64 (encoding/json's
// []byte) of 16 kHz mono int16 little-endian samples.
type AudioParams struct {
	Session string `json:"session"`
	PCM     []byte `json:"pcm"`
}

// SpeechEvent is a VAD edge.
type SpeechEvent struct {
	Session string `json:"session"`
	Active  bool   `json:"active"`
}

// PhraseEvent is one transcribed phrase.
type PhraseEvent struct {
	Session string `json:"session"`
	Text    string `json:"text"`
	StartMS int64  `json:"start_ms"`
	EndMS   int64  `json:"end_ms"`
	InferMS int64  `json:"infer_ms"`
}

// UnloadedEvent says the engine dropped the model by itself (memory pressure).
type UnloadedEvent struct {
	Reason string `json:"reason"`
}

// StateEvent is the engine's own state (idle, loading, ready, listening, transcribing).
type StateEvent struct {
	State string `json:"state"`
}

// ErrorEvent is a failure the engine survived.
type ErrorEvent struct {
	Message string `json:"message"`
}

// Event is one event from the engine.
type Event struct {
	Name   string
	Params json.RawMessage
}

// Engine is a running engine process as the store drives it. EngineConn over a real
// process; dictationtest.Engine in tests.
type Engine interface {
	// Call sends a request and decodes its result into result (nil to discard).
	Call(ctx context.Context, method string, params, result any) error
	// Notify sends a notification.
	Notify(method string, params any) error
	// Events delivers the engine's events in order; closed after Done.
	Events() <-chan Event
	// Enqueued counts the events the engine has sent so far. An event the engine sent
	// before a reply is counted by the time Call returns, so Stop can wait for the
	// phrases a flush produced.
	Enqueued() uint64
	// Done is closed once the engine has exited (or its output ended).
	Done() <-chan struct{}
	// Err says how it ended; valid after Done.
	Err() error
	// Close asks the engine to shut down, then kills it after a grace, and returns once
	// it has exited.
	Close()
}

// Launcher starts an engine.
type Launcher func(ctx context.Context) (Engine, error)

// ErrEngineMissing is a launcher whose executable is not there: no restart helps.
var ErrEngineMissing = errors.New("the dictation engine is not installed")

// ProcessLauncher starts the executable at path (code-foundry-dictate).
func ProcessLauncher(path string, log *slog.Logger) Launcher {
	return func(ctx context.Context) (Engine, error) {
		if _, err := os.Stat(path); err != nil {
			return nil, fmt.Errorf("%w (%s)", ErrEngineMissing, path)
		}
		proc, err := childproc.Start(childproc.Spec{
			Argv: []string{path}, Name: "dictation engine",
			StderrLine: func(l string) { log.Debug("engine stderr", "line", l) },
		})
		if err != nil {
			return nil, err
		}
		return newEngineConn(proc.Stdout(), proc.Stdin(), proc), nil
	}
}

// process is the slice of *childproc.Process an EngineConn needs.
type process interface {
	Done() <-chan struct{}
	ExitCode() int
	LastStderrLine() string
	Signal(syscall.Signal) error
	CloseOutput()
}

// EngineConn speaks the protocol over a process's stdio.
type EngineConn struct {
	w    io.WriteCloser
	proc process // nil for a bare pipe (tests)

	wmu    sync.Mutex
	nextID int64

	pmu     sync.Mutex
	pending map[int64]chan reply
	closed  bool

	events   chan Event
	enqueued atomic.Uint64
	done     chan struct{}
	err      error
}

type reply struct {
	Result json.RawMessage
	Err    error
}

// newEngineConn reads r and writes w; proc, when set, is the process behind them.
func newEngineConn(r io.Reader, w io.WriteCloser, proc process) *EngineConn {
	c := &EngineConn{w: w, proc: proc, pending: map[int64]chan reply{}, events: make(chan Event, 256), done: make(chan struct{})}
	go c.read(r)
	return c
}

// shutdownGrace is how long Close waits for a shutdown reply, then for the exit, before
// killing the engine.
const shutdownGrace = 2 * time.Second

type wireIn struct {
	ID     *int64          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
	Event  string          `json:"event"`
	Params json.RawMessage `json:"params"`
}

func (c *EngineConn) read(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		var in wireIn
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil {
			continue // not protocol: a stray line
		}
		switch {
		case in.ID != nil:
			c.pmu.Lock()
			ch := c.pending[*in.ID]
			delete(c.pending, *in.ID)
			c.pmu.Unlock()
			if ch != nil {
				rep := reply{Result: in.Result}
				if in.Error != nil {
					rep.Err = errors.New(in.Error.Message)
				}
				ch <- rep
			}
		case in.Event != "":
			// Blocks when the store falls behind, which holds the engine's output back
			// rather than dropping a phrase.
			c.enqueued.Add(1)
			c.events <- Event{Name: in.Event, Params: in.Params}
		}
	}
	err := sc.Err()
	if c.proc != nil {
		<-c.proc.Done()
		if err == nil {
			err = exitError(c.proc)
		}
	} else if err == nil {
		err = errors.New("the engine closed its output")
	}
	c.pmu.Lock()
	c.closed = true
	c.err = err
	for id, ch := range c.pending {
		ch <- reply{Err: fmt.Errorf("the engine stopped: %w", err)}
		delete(c.pending, id)
	}
	c.pmu.Unlock()
	close(c.events)
	close(c.done)
}

func exitError(p process) error {
	msg := fmt.Sprintf("the engine exited with status %d", p.ExitCode())
	if p.ExitCode() < 0 {
		msg = "the engine was killed by a signal"
	}
	if l := p.LastStderrLine(); l != "" {
		msg += ": " + l
	}
	return errors.New(msg)
}

func (c *EngineConn) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(b)
	return err
}

// Call implements Engine.
func (c *EngineConn) Call(ctx context.Context, method string, params, result any) error {
	ch := make(chan reply, 1)
	c.pmu.Lock()
	if c.closed {
		err := c.err
		c.pmu.Unlock()
		return fmt.Errorf("the engine stopped: %w", err)
	}
	c.nextID++
	id := c.nextID
	c.pending[id] = ch
	c.pmu.Unlock()
	if params == nil {
		params = struct{}{}
	}
	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.forget(id)
		return fmt.Errorf("%s: %w", method, err)
	}
	select {
	case rep := <-ch:
		if rep.Err != nil {
			return fmt.Errorf("%s: %w", method, rep.Err)
		}
		if result != nil && len(rep.Result) > 0 {
			if err := json.Unmarshal(rep.Result, result); err != nil {
				return fmt.Errorf("%s: decode result: %w", method, err)
			}
		}
		return nil
	case <-ctx.Done():
		c.forget(id)
		return fmt.Errorf("%s: %w", method, ctx.Err())
	}
}

func (c *EngineConn) forget(id int64) {
	c.pmu.Lock()
	delete(c.pending, id)
	c.pmu.Unlock()
}

// Notify implements Engine.
func (c *EngineConn) Notify(method string, params any) error {
	return c.write(map[string]any{"method": method, "params": params})
}

// Events implements Engine.
func (c *EngineConn) Events() <-chan Event { return c.events }

// Enqueued implements Engine.
func (c *EngineConn) Enqueued() uint64 { return c.enqueued.Load() }

// Done implements Engine.
func (c *EngineConn) Done() <-chan struct{} { return c.done }

// Err implements Engine.
func (c *EngineConn) Err() error {
	c.pmu.Lock()
	defer c.pmu.Unlock()
	return c.err
}

// Close implements Engine: shutdown, then stdin closed, then SIGKILL to its group.
func (c *EngineConn) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	_ = c.Call(ctx, MethodShutdown, nil, nil)
	_ = c.w.Close()
	wait := func() bool {
		select {
		case <-c.done:
			return true
		case <-time.After(shutdownGrace):
			return false
		}
	}
	if c.proc == nil || wait() {
		return
	}
	_ = c.proc.Signal(syscall.SIGKILL)
	if !wait() {
		c.proc.CloseOutput()
	}
}
