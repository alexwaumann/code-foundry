package claudestream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
)

// Errors.
var (
	// ErrClosed: the CLI's stdout ended (the process exited or is exiting), so no
	// response will come.
	ErrClosed = errors.New("claudestream: connection closed")
	// ErrCancelled is the cause of a PermissionHandler's context when the CLI withdrew
	// the request (control_cancel_request, after an interrupt).
	ErrCancelled = errors.New("claudestream: request withdrawn by claude")
)

// ControlError is a control_response with subtype "error".
type ControlError struct {
	Subtype string // the request's subtype
	Message string
}

func (e *ControlError) Error() string {
	return fmt.Sprintf("claude refused %s: %s", e.Subtype, e.Message)
}

// PermissionHandler decides an inbound can_use_tool request. It runs in its own
// goroutine and may block as long as it needs (a person is deciding): the request
// stays pending until it returns. ctx is cancelled when the CLI withdraws the request
// (cause ErrCancelled) or its stdout ends (cause ErrClosed); the handler's result is
// then not sent. A returned error is sent as a deny carrying the error text.
type PermissionHandler func(ctx context.Context, req *PermissionRequest) (PermissionResult, error)

// Options configures a Conn.
type Options struct {
	// OnPermission decides can_use_tool requests. Nil denies every request.
	OnPermission PermissionHandler
	// MaxLine bounds one stdout line; 0 means DefaultMaxLine.
	MaxLine int
	// Log receives protocol warnings (undecodable lines, unsupported requests).
	// Default slog.Default().
	Log *slog.Logger
}

// Conn speaks the control protocol over a CLI's stdin and stdout. All methods are
// safe for concurrent use. Lines other than control traffic are delivered in order on
// Events, which is closed after the last one once stdout ends.
type Conn struct {
	w    io.WriteCloser
	opts Options
	log  *slog.Logger

	wmu     sync.Mutex
	wclosed bool

	mu       sync.Mutex
	next     int
	waiting  map[string]chan controlReply
	handlers map[string]context.CancelCauseFunc
	q        []Event
	ended    bool

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
		waiting:  map[string]chan controlReply{},
		handlers: map[string]context.CancelCauseFunc{},
		sig:      make(chan struct{}, 1),
		events:   make(chan Event),
		done:     make(chan struct{}),
		stop:     make(chan struct{}),
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	go c.read(r)
	go c.pump()
	return c
}

// Events delivers every inbound line that is not a response to our own request or a
// can_use_tool request, in order. It is closed once stdout has ended and every event
// was delivered (or after Close).
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
	handlers := c.handlers
	c.handlers = map[string]context.CancelCauseFunc{}
	c.mu.Unlock()
	for _, ch := range waiting {
		close(ch)
	}
	for _, cancel := range handlers {
		cancel(ErrClosed)
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
		c.mu.Lock()
		cancel, ok := c.handlers[e.RequestID]
		delete(c.handlers, e.RequestID)
		c.mu.Unlock()
		if ok {
			cancel(ErrCancelled)
		}
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
	if head.Subtype != SubtypeCanUseTool {
		c.log.Info("claudestream: unsupported control request from claude", "subtype", head.Subtype)
		_ = c.reply(e.RequestID, nil, "unsupported control request: "+head.Subtype)
		return
	}
	req := &PermissionRequest{}
	if err := json.Unmarshal(e.Request, req); err != nil {
		_ = c.reply(e.RequestID, nil, "bad can_use_tool request: "+err.Error())
		return
	}
	req.RequestID, req.Raw = e.RequestID, e.Raw
	ctx, cancel := context.WithCancelCause(context.Background())
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		cancel(ErrClosed)
		return
	}
	c.handlers[e.RequestID] = cancel
	c.mu.Unlock()
	go func() {
		defer cancel(nil)
		var res PermissionResult
		var err error
		if c.opts.OnPermission == nil {
			res = PermissionResult{Message: "No one can answer permission prompts here."}
		} else {
			res, err = c.opts.OnPermission(ctx, req)
		}
		c.mu.Lock()
		_, live := c.handlers[e.RequestID]
		delete(c.handlers, e.RequestID)
		c.mu.Unlock()
		if !live || ctx.Err() != nil {
			return // withdrawn or the process is gone
		}
		if err != nil {
			res = PermissionResult{Message: err.Error()}
		}
		if werr := c.reply(e.RequestID, res.wire(req.Input), ""); werr != nil {
			c.log.Warn("claudestream: answer permission request", "request_id", e.RequestID, "err", werr)
		}
	}()
}

// reply writes a control_response: success with payload, or error with msg.
func (c *Conn) reply(id string, payload any, msg string) error {
	resp := map[string]any{"subtype": "success", "request_id": id}
	if msg != "" {
		resp = map[string]any{"subtype": "error", "request_id": id, "error": msg}
	} else if payload != nil {
		resp["response"] = payload
	}
	return c.write(map[string]any{"type": "control_response", "response": resp})
}

func (c *Conn) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("claudestream: encode: %w", err)
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.wclosed {
		return fmt.Errorf("claudestream: write: %w", ErrClosed)
	}
	if _, err := c.w.Write(b); err != nil {
		return fmt.Errorf("claudestream: write: %w", err)
	}
	return nil
}

// Send writes a user message. The CLI accepts one while a turn runs (it queues or
// folds it in, as typing while busy does in the TUI).
func (c *Conn) Send(_ context.Context, m UserMessage) error {
	if len(m.Blocks) == 0 {
		return errors.New("claudestream: empty user message")
	}
	return c.write(m.wire())
}

// CloseStdin closes the CLI's stdin: an idle CLI exits; a running turn finishes first.
func (c *Conn) CloseStdin() error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.wclosed {
		return nil
	}
	c.wclosed = true
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
	if err := c.write(map[string]any{"type": "control_request", "request_id": id, "request": req}); err != nil {
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
// requests are withdrawn by the CLI (their handlers' contexts are cancelled).
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
