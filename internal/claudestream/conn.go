package claudestream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Errors.
var (
	// ErrClosed: the CLI's stdout ended or its stdin is gone (the process exited or is
	// exiting), so no response will come.
	ErrClosed = errors.New("claudestream: connection closed")
	// ErrCancelled: PermissionRequest.Answer after the CLI withdrew the request
	// (control_cancel_request, after an interrupt).
	ErrCancelled = errors.New("claudestream: request withdrawn by claude")
	// ErrAnswered: PermissionRequest.Answer called twice.
	ErrAnswered = errors.New("claudestream: request already answered")
	// ErrStalled: a write to the CLI's stdin did not finish by its deadline: the CLI
	// stopped reading it (its event loop is stuck). When part of the line went out,
	// stdin is closed: nothing written after half a line would parse.
	ErrStalled = errors.New("claudestream: claude is not reading its input")
)

// WriteTimeout bounds a write to the CLI's stdin whose ctx has no deadline (answers
// to the CLI's own requests). A pipe's buffer is 64 KB: a large message (an inline
// image) waits for the CLI to read it.
const WriteTimeout = 30 * time.Second

// ControlError is a control_response with subtype "error".
type ControlError struct {
	Subtype string // the request's subtype
	Message string
}

func (e *ControlError) Error() string {
	return fmt.Sprintf("claude refused %s: %s", e.Subtype, e.Message)
}

// Options configures a Conn.
type Options struct {
	// MaxLine bounds one stdout line; 0 means DefaultMaxLine.
	MaxLine int
	// Log receives protocol warnings (undecodable lines, unsupported requests).
	// Default slog.Default().
	Log *slog.Logger
}

// Conn speaks the control protocol over a CLI's stdin and stdout. All methods are
// safe for concurrent use. Every line other than a response to our own request is
// delivered in order on Events, inbound can_use_tool requests included (as
// *PermissionRequest, answered with its Answer method), so a request is seen after the
// assistant frame carrying its tool_use. Events is closed after the last line once
// stdout ends.
type Conn struct {
	w    io.WriteCloser
	opts Options
	log  *slog.Logger

	// wmu orders writes; stdinClosed is set without it, so CloseStdin never waits
	// behind a write the CLI does not read (closing the pipe ends that write).
	wmu         sync.Mutex
	stdinClosed atomic.Bool

	mu      sync.Mutex
	next    int
	waiting map[string]chan controlReply
	inbound map[string]struct{} // can_use_tool requests not yet answered or withdrawn
	q       []Event
	ended   bool

	sig    chan struct{}
	events chan Event
	done   chan struct{} // stdout ended
	stop   chan struct{} // Close: stop delivering
	once   sync.Once
	rerr   error
}

type controlReply struct {
	ok      bool
	payload json.RawMessage
	err     string
}

// NewConn starts reading r (the CLI's stdout) and writing requests to w (its stdin).
// Nothing is sent until the caller does: start with Initialize.
func NewConn(r io.Reader, w io.WriteCloser, opts Options) *Conn {
	c := &Conn{
		w: w, opts: opts, log: opts.Log,
		waiting: map[string]chan controlReply{},
		inbound: map[string]struct{}{},
		sig:     make(chan struct{}, 1),
		events:  make(chan Event),
		done:    make(chan struct{}),
		stop:    make(chan struct{}),
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	go c.read(r)
	go c.pump()
	return c
}

// Events delivers every inbound line that is not a response to our own request, in
// order: a can_use_tool request is a *PermissionRequest (answer it with Answer), its
// withdrawal a *ControlCancel. It is closed once stdout has ended and every event was
// delivered (or after Close).
func (c *Conn) Events() <-chan Event { return c.events }

// Done is closed when stdout ends.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err is the read error that ended stdout, nil for a clean EOF. Valid after Done.
func (c *Conn) Err() error { return c.rerr }

// Close stops delivering events and makes pending and future requests fail. It does
// not close stdin (CloseStdin) or stop the reader, which ends with the process.
func (c *Conn) Close() {
	c.once.Do(func() { close(c.stop) })
}

func (c *Conn) read(r io.Reader) {
	err := ReadLines(r, c.opts.MaxLine, func(line []byte) { c.dispatch(Parse(line)) })
	c.mu.Lock()
	c.rerr, c.ended = err, true
	waiting := c.waiting
	c.waiting = map[string]chan controlReply{}
	c.inbound = map[string]struct{}{} // the process is gone: nothing can be answered
	c.mu.Unlock()
	for _, ch := range waiting {
		close(ch)
	}
	close(c.done)
	c.wake()
}

func (c *Conn) wake() {
	select {
	case c.sig <- struct{}{}:
	default:
	}
}

func (c *Conn) push(ev Event) {
	c.mu.Lock()
	c.q = append(c.q, ev)
	c.mu.Unlock()
	c.wake()
}

// pump moves queued events to the events channel, so the reader never waits on the
// consumer.
func (c *Conn) pump() {
	defer close(c.events)
	for {
		c.mu.Lock()
		q, ended := c.q, c.ended
		c.q = nil
		c.mu.Unlock()
		for _, ev := range q {
			select {
			case c.events <- ev:
			case <-c.stop:
				return
			}
		}
		if len(q) > 0 {
			continue
		}
		if ended {
			return
		}
		select {
		case <-c.sig:
		case <-c.stop:
			return
		}
	}
}

func (c *Conn) dispatch(ev Event) {
	switch e := ev.(type) {
	case *controlResponseLine:
		c.mu.Lock()
		ch, ok := c.waiting[e.Response.RequestID]
		delete(c.waiting, e.Response.RequestID)
		c.mu.Unlock()
		if !ok {
			c.log.Debug("claudestream: response to an unknown request", "request_id", e.Response.RequestID)
			return
		}
		ch <- controlReply{ok: e.Response.Subtype == "success", payload: e.Response.Response, err: e.Response.Error}
		close(ch)
	case *controlRequestLine:
		c.onRequest(e)
	case *ControlCancel:
		// Withdrawn before the event reaches the consumer, so a later Answer sends
		// nothing (ErrCancelled).
		c.mu.Lock()
		delete(c.inbound, e.RequestID)
		c.mu.Unlock()
		c.push(ev)
	case *Unknown:
		if e.Err != nil {
			c.log.Warn("claudestream: undecodable line", "err", e.Err, "bytes", len(e.Raw))
		}
		c.push(ev)
	default:
		c.push(ev)
	}
}

func (c *Conn) onRequest(e *controlRequestLine) {
	var head struct {
		Subtype string `json:"subtype"`
	}
	_ = json.Unmarshal(e.Request, &head)
	// Replies go out on their own goroutine: onRequest runs on the reader, and a
	// write that waits for the CLI to drain stdin must not stop stdout being read.
	if head.Subtype != SubtypeCanUseTool {
		c.log.Info("claudestream: unsupported control request from claude", "subtype", head.Subtype)
		go func() { _ = c.reply(e.RequestID, nil, "unsupported control request: "+head.Subtype) }()
		return
	}
	req := &PermissionRequest{}
	if err := json.Unmarshal(e.Request, req); err != nil {
		go func() { _ = c.reply(e.RequestID, nil, "bad can_use_tool request: "+err.Error()) }()
		return
	}
	req.RequestID, req.Raw, req.conn = e.RequestID, e.Raw, c
	c.mu.Lock()
	c.inbound[e.RequestID] = struct{}{}
	c.mu.Unlock()
	// Delivered in order with the other lines: the CLI writes the assistant frame
	// carrying the tool_use before asking about it.
	c.push(req)
}

// answer sends the result of inbound request req unless it was withdrawn, already
// answered, or stdout ended. The write goes out on its own goroutine: the caller may
// be a loop that must keep reading events while the CLI drains stdin.
func (c *Conn) answer(req *PermissionRequest, res PermissionResult) error {
	c.mu.Lock()
	_, live := c.inbound[req.RequestID]
	delete(c.inbound, req.RequestID)
	answered := req.answered
	req.answered = true
	ended := c.ended
	c.mu.Unlock()
	switch {
	case answered:
		return ErrAnswered
	case live:
	case ended:
		return ErrClosed
	default:
		return ErrCancelled
	}
	go func() {
		if err := c.reply(req.RequestID, res.wire(req.Input), ""); err != nil {
			c.log.Warn("claudestream: answer permission request", "request_id", req.RequestID, "err", err)
		}
	}()
	return nil
}

// reply writes a control_response: success with payload, or error with msg.
func (c *Conn) reply(id string, payload any, msg string) error {
	resp := map[string]any{"subtype": "success", "request_id": id}
	if msg != "" {
		resp = map[string]any{"subtype": "error", "request_id": id, "error": msg}
	} else if payload != nil {
		resp["response"] = payload
	}
	return c.write(context.Background(), map[string]any{"type": "control_response", "response": resp})
}

// write writes v as one line by ctx's deadline (WriteTimeout without one), when the
// writer takes deadlines (an *os.File pipe does); ErrStalled past it. Writers without
// deadlines block until the line is written or stdin is closed.
func (c *Conn) write(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("claudestream: encode: %w", err)
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.stdinClosed.Load() {
		return fmt.Errorf("claudestream: write: %w", ErrClosed)
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(WriteTimeout)
	}
	dw, timed := c.w.(interface{ SetWriteDeadline(time.Time) error })
	if timed && dw.SetWriteDeadline(deadline) != nil {
		timed = false // not pollable, or closed meanwhile (the write says which)
	}
	n, err := c.w.Write(b)
	if timed {
		_ = dw.SetWriteDeadline(time.Time{})
	}
	switch {
	case err == nil:
		return nil
	case errors.Is(err, os.ErrDeadlineExceeded):
		if n > 0 {
			_ = c.CloseStdin()
		}
		return fmt.Errorf("claudestream: write (%d of %d bytes): %w", n, len(b), ErrStalled)
	case stdinGone(err) || c.stdinClosed.Load():
		return fmt.Errorf("claudestream: write: %w: %w", ErrClosed, err)
	}
	return fmt.Errorf("claudestream: write: %w", err)
}

// stdinGone reports whether a write failed because the CLI's stdin has no reader any
// more: the process exited before it read (EPIPE; Go ignores SIGPIPE on a pipe that is
// not its own stdout), exec closed the pipe after the exit (os.ErrClosed), or an
// in-process pipe's reader closed (io.ErrClosedPipe). Like stdout ending, it means the
// process is gone or going.
func stdinGone(err error) bool {
	return errors.Is(err, syscall.EPIPE) || errors.Is(err, os.ErrClosed) || errors.Is(err, io.ErrClosedPipe)
}

// Send writes a user message. The CLI accepts one while a turn runs: Claude picks it
// up mid-turn, inside the running turn (one result at its end), as typing while busy
// does in the TUI.
// The write ends by ctx's deadline (WriteTimeout without one): ErrStalled when the
// CLI does not read it by then.
func (c *Conn) Send(ctx context.Context, m UserMessage) error {
	if len(m.Blocks) == 0 {
		return errors.New("claudestream: empty user message")
	}
	return c.write(ctx, m.wire())
}

// CloseStdin closes the CLI's stdin: an idle CLI exits; a running turn finishes first.
// It does not wait for a write under way, which it ends (ErrClosed).
func (c *Conn) CloseStdin() error {
	if !c.stdinClosed.CompareAndSwap(false, true) {
		return nil
	}
	return c.w.Close()
}

// Request sends a control request and waits for its response. The success payload
// is returned raw (nil when the CLI sent none); an error response is a *ControlError.
func (c *Conn) Request(ctx context.Context, req ControlRequest) (json.RawMessage, error) {
	subtype, _ := req["subtype"].(string)
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return nil, ErrClosed
	}
	c.next++
	id := "cf-" + strconv.Itoa(c.next)
	ch := make(chan controlReply, 1)
	c.waiting[id] = ch
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.waiting, id)
		c.mu.Unlock()
	}
	if err := c.write(ctx, map[string]any{"type": "control_request", "request_id": id, "request": req}); err != nil {
		forget()
		return nil, err
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, ErrClosed
		}
		if !r.ok {
			return nil, &ControlError{Subtype: subtype, Message: r.err}
		}
		if string(r.payload) == "null" {
			return nil, nil
		}
		return r.payload, nil
	case <-c.stop:
		forget()
		return nil, ErrClosed
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
}

// Initialize performs the handshake every stdio session must start with; without it
// every permission prompt is auto-denied.
func (c *Conn) Initialize(ctx context.Context) (*InitializeResponse, error) {
	raw, err := c.Request(ctx, ControlRequest{"subtype": SubtypeInitialize})
	if err != nil {
		return nil, err
	}
	var r InitializeResponse
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("claudestream: initialize response: %w", err)
		}
	}
	return &r, nil
}

// Interrupt stops the running turn (a no-op when idle). Pending can_use_tool
// requests are withdrawn by the CLI (a *ControlCancel each on Events).
func (c *Conn) Interrupt(ctx context.Context) error {
	_, err := c.Request(ctx, ControlRequest{"subtype": SubtypeInterrupt})
	return err
}

// SetModel switches the model for the next request; "" resets to the session default.
func (c *Conn) SetModel(ctx context.Context, model string) error {
	req := ControlRequest{"subtype": SubtypeSetModel}
	if model != "" {
		req["model"] = model
	}
	_, err := c.Request(ctx, req)
	return err
}

// SetPermissionMode switches the permission mode (ModeDefault, ModeAcceptEdits,
// ModeAuto, ...).
func (c *Conn) SetPermissionMode(ctx context.Context, mode string) error {
	_, err := c.Request(ctx, ControlRequest{"subtype": SubtypeSetPermissionMode, "mode": mode})
	return err
}

// SetCwd moves the conversation to another directory (like /cd). A response with
// Status other than "ok" is returned without an error; check it.
func (c *Conn) SetCwd(ctx context.Context, path string) (*SetCwdResponse, error) {
	raw, err := c.Request(ctx, ControlRequest{"subtype": SubtypeSetCwd, "path": path})
	if err != nil {
		return nil, err
	}
	var r SetCwdResponse
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("claudestream: set_cwd response: %w", err)
		}
	}
	return &r, nil
}
