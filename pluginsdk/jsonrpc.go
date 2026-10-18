package pluginsdk

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
)

// JSON-RPC error codes: the standard ones, then the protocol's own.
const (
	CodeParseError     = -32700
	CodeInvalidRequest = -32600
	// CodeMethodNotFound is also the answer to a method this host or plugin does not
	// support (yet).
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeInternal       = -32603
	// CodePermissionDenied: the manifest does not grant what the call needs.
	CodePermissionDenied = -32001
	// CodeUnavailable: the command is not available in that context (its message says why).
	CodeUnavailable = -32002
	// CodeConfirmationRequired: the command asks the user first; data is {"message": …}.
	// A plugin can never confirm on the user's behalf.
	CodeConfirmationRequired = -32003
	CodeNotFound             = -32004
	CodeRateLimited          = -32005
)

// MaxQueue bounds the bytes a Conn has queued for writing. A peer that stops reading
// fills it, and further writes fail with ErrQueueFull instead of blocking the writer.
const MaxQueue = 4 << 20

var (
	// ErrClosed is returned by calls on a closed Conn and by calls in flight when it
	// closes (the peer went away).
	ErrClosed = errors.New("pluginsdk: connection closed")
	// ErrQueueFull is returned when the outbound queue is full: the peer is not reading.
	ErrQueueFull = errors.New("pluginsdk: outbound queue full")
)

// Error is a JSON-RPC error object. Handlers return one to choose the code; any other
// error becomes CodeInternal with its message.
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// NewError returns an *Error with a formatted message.
func NewError(code int, format string, a ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, a...)}
}

// ErrorCode returns err's JSON-RPC code: the *Error's, ErrClosed's CodeInternal, 0 for nil.
func ErrorCode(err error) int {
	var e *Error
	switch {
	case err == nil:
		return 0
	case errors.As(err, &e):
		return e.Code
	default:
		return CodeInternal
	}
}

// ConnOptions configures a Conn.
type ConnOptions struct {
	// Handle answers an incoming request. Each request runs on its own goroutine with a
	// context cancelled when the Conn closes. Nil answers every request with
	// CodeMethodNotFound.
	Handle func(ctx context.Context, method string, params json.RawMessage) (any, error)
	// Notify receives incoming notifications in order, on one goroutine. Nil drops them.
	Notify func(ctx context.Context, method string, params json.RawMessage)
	// MaxLine is the longest line read or written (default MaxLine).
	MaxLine int
	// MaxQueue bounds the outbound queue in bytes (default MaxQueue).
	MaxQueue int
	// OnIssue is told about protocol problems: oversize or malformed lines, unknown
	// response ids, a full queue, a panicking handler. Nil ignores them.
	OnIssue func(msg string)
	// Answered, when set, is called after the response to an incoming request has been
	// queued (Serve stops after answering shutdown).
	Answered func(method string)
}

// wire is one JSON-RPC 2.0 message, any kind.
type wire struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type response struct {
	result json.RawMessage
	err    error
}

type notification struct {
	method string
	params json.RawMessage
}

// Conn is one side of a newline-delimited JSON-RPC 2.0 connection. Reads, writes and
// incoming notifications each have their own goroutine, so the reader never blocks on
// a handler and a peer that stops reading cannot block a caller: writes go through a
// bounded queue.
type Conn struct {
	opts   ConnOptions
	w      io.Writer
	ctx    context.Context // cancelled when the Conn closes
	cancel context.CancelFunc
	nextID atomic.Int64

	mu      sync.Mutex
	pending map[int64]chan response
	err     error // why the Conn closed; nil while open
	done    chan struct{}

	qmu     sync.Mutex
	qcond   *sync.Cond
	queue   [][]byte
	qbytes  int
	qclosed bool
	wdone   chan struct{} // closed when the writer has drained the queue and exited

	nmu     sync.Mutex
	ncond   *sync.Cond
	nqueue  []notification
	nclosed bool
}

// NewConn starts a Conn reading r and writing w. It runs until r ends or Close.
func NewConn(r io.Reader, w io.Writer, opts ConnOptions) *Conn {
	if opts.MaxLine <= 0 {
		opts.MaxLine = MaxLine
	}
	if opts.MaxQueue <= 0 {
		opts.MaxQueue = MaxQueue
	}
	c := &Conn{opts: opts, w: w, pending: map[int64]chan response{}, done: make(chan struct{}), wdone: make(chan struct{})}
	c.ctx, c.cancel = context.WithCancel(context.Background())
	c.qcond = sync.NewCond(&c.qmu)
	c.ncond = sync.NewCond(&c.nmu)
	go c.readLoop(r)
	go c.writeLoop()
	go c.notifyLoop()
	return c
}

// Done is closed when the Conn has closed: the peer's output ended, a write failed, or
// Close was called.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err is why the Conn closed (io.EOF when the peer's output ended), nil while open.
func (c *Conn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close closes the Conn: calls in flight fail with ErrClosed and the writer exits once
// it has written what is queued. It does not close the underlying reader or writer.
func (c *Conn) Close() error {
	c.shutdown(ErrClosed)
	return nil
}

// Drained is closed once the writer has written everything queued before Close and
// exited (or failed). Wait on it, bounded, before exiting a process that just answered.
func (c *Conn) Drained() <-chan struct{} { return c.wdone }

func (c *Conn) issue(format string, a ...any) {
	if c.opts.OnIssue != nil {
		c.opts.OnIssue(fmt.Sprintf(format, a...))
	}
}

func (c *Conn) shutdown(cause error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = cause
	pending := c.pending
	c.pending = map[int64]chan response{}
	close(c.done)
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- response{err: ErrClosed}
	}
	c.cancel()
	c.qmu.Lock()
	c.qclosed = true
	c.qcond.Broadcast()
	c.qmu.Unlock()
	c.nmu.Lock()
	c.nclosed = true
	c.ncond.Broadcast()
	c.nmu.Unlock()
}

// Call sends a request and waits for its response, ctx, or the Conn closing. A
// JSON-RPC error comes back as *Error. result, when non-nil, receives the result.
func (c *Conn) Call(ctx context.Context, method string, params, result any) error {
	id := c.nextID.Add(1)
	ch := make(chan response, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return ErrClosed
	}
	c.pending[id] = ch
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	if err := c.send(wire{ID: json.RawMessage(strconv.FormatInt(id, 10)), Method: method}, params); err != nil {
		forget()
		return err
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if result != nil && len(r.result) > 0 {
			if err := json.Unmarshal(r.result, result); err != nil {
				return fmt.Errorf("pluginsdk: %s: decode result: %w", method, err)
			}
		}
		return nil
	case <-ctx.Done():
		forget()
		return ctx.Err()
	}
}

// Notify sends a notification.
func (c *Conn) Notify(method string, params any) error {
	return c.send(wire{Method: method}, params)
}

// Queued is how many bytes wait in the outbound queue: a sender with much to say (the
// host's event feed) holds back while the peer is behind instead of filling the queue.
func (c *Conn) Queued() int {
	c.qmu.Lock()
	defer c.qmu.Unlock()
	return c.qbytes
}

// send encodes m with params and queues it.
func (c *Conn) send(m wire, params any) error {
	if params != nil {
		raw, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("pluginsdk: %s: encode params: %w", m.Method, err)
		}
		m.Params = raw
	}
	return c.enqueue(m)
}

func (c *Conn) enqueue(m wire) error {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("pluginsdk: encode message: %w", err)
	}
	if len(b) > c.opts.MaxLine {
		return fmt.Errorf("pluginsdk: message of %d bytes is over the %d byte line limit", len(b), c.opts.MaxLine)
	}
	b = append(b, '\n')
	c.qmu.Lock()
	defer c.qmu.Unlock()
	if c.qclosed {
		return ErrClosed
	}
	if c.qbytes+len(b) > c.opts.MaxQueue {
		c.issue("outbound queue full (%d bytes): the peer is not reading", c.qbytes)
		return ErrQueueFull
	}
	c.queue = append(c.queue, b)
	c.qbytes += len(b)
	c.qcond.Signal()
	return nil
}

func (c *Conn) writeLoop() {
	defer close(c.wdone)
	for {
		c.qmu.Lock()
		for len(c.queue) == 0 && !c.qclosed {
			c.qcond.Wait()
		}
		batch := c.queue
		c.queue = nil
		c.qmu.Unlock()
		if len(batch) == 0 {
			return // closed and drained
		}
		for _, b := range batch {
			if _, err := c.w.Write(b); err != nil {
				c.shutdown(fmt.Errorf("pluginsdk: write: %w", err))
				return
			}
			c.qmu.Lock()
			c.qbytes -= len(b)
			c.qmu.Unlock()
		}
	}
}

func (c *Conn) readLoop(r io.Reader) {
	sp := splitter{max: c.opts.MaxLine}
	br := bufio.NewReaderSize(r, 64<<10)
	buf := make([]byte, 64<<10)
	var lines [][]byte
	for {
		n, err := br.Read(buf)
		if n > 0 {
			skipped := sp.skipped
			lines = sp.split(lines[:0], buf[:n])
			if sp.skipped > skipped {
				c.issue("skipped a line over the %d byte limit", c.opts.MaxLine)
			}
			for _, l := range lines {
				c.dispatch(l)
			}
		}
		if err != nil {
			if rest := sp.rest(); rest != nil {
				c.dispatch(rest)
			}
			if errors.Is(err, io.EOF) {
				c.shutdown(io.EOF)
			} else {
				c.shutdown(fmt.Errorf("pluginsdk: read: %w", err))
			}
			return
		}
	}
}

func (c *Conn) dispatch(line []byte) {
	var m wire
	if err := json.Unmarshal(line, &m); err != nil {
		c.issue("malformed line: %v", err)
		return
	}
	hasID := len(m.ID) > 0 && string(m.ID) != "null"
	switch {
	case m.Method != "" && hasID:
		go c.answer(m)
	case m.Method != "":
		c.nmu.Lock()
		if !c.nclosed {
			c.nqueue = append(c.nqueue, notification{method: m.Method, params: m.Params})
			c.ncond.Signal()
		}
		c.nmu.Unlock()
	case hasID:
		id, err := strconv.ParseInt(string(m.ID), 10, 64)
		c.mu.Lock()
		ch, ok := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if err != nil || !ok {
			c.issue("response to unknown id %s", m.ID)
			return
		}
		if m.Error != nil {
			ch <- response{err: m.Error}
		} else {
			ch <- response{result: m.Result}
		}
	default:
		c.issue("line is neither a request, a notification nor a response")
	}
}

// answer runs the handler for request m and sends its response.
func (c *Conn) answer(m wire) {
	result, err := c.handle(m)
	out := wire{ID: m.ID}
	if err != nil {
		var e *Error
		if !errors.As(err, &e) {
			e = &Error{Code: CodeInternal, Message: err.Error()}
		}
		out.Error = e
	} else {
		if result == nil {
			result = struct{}{}
		}
		raw, merr := json.Marshal(result)
		if merr != nil {
			out.Error = &Error{Code: CodeInternal, Message: "encode result: " + merr.Error()}
		} else {
			out.Result = raw
		}
	}
	if err := c.enqueue(out); err != nil && !errors.Is(err, ErrClosed) {
		c.issue("answer %s: %v", m.Method, err)
	}
	if c.opts.Answered != nil {
		c.opts.Answered(m.Method)
	}
}

func (c *Conn) handle(m wire) (result any, err error) {
	if c.opts.Handle == nil {
		return nil, NewError(CodeMethodNotFound, "method %q not found", m.Method)
	}
	defer func() {
		if r := recover(); r != nil {
			c.issue("handler for %s panicked: %v\n%s", m.Method, r, debug.Stack())
			result, err = nil, NewError(CodeInternal, "%s: internal error", m.Method)
		}
	}()
	return c.opts.Handle(c.ctx, m.Method, m.Params)
}

func (c *Conn) notifyLoop() {
	for {
		c.nmu.Lock()
		for len(c.nqueue) == 0 && !c.nclosed {
			c.ncond.Wait()
		}
		if c.nclosed && len(c.nqueue) == 0 {
			c.nmu.Unlock()
			return
		}
		n := c.nqueue[0]
		c.nqueue = c.nqueue[1:]
		c.nmu.Unlock()
		c.notifyOne(n)
	}
}

func (c *Conn) notifyOne(n notification) {
	if c.opts.Notify == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			c.issue("notification handler for %s panicked: %v\n%s", n.method, r, debug.Stack())
		}
	}()
	c.opts.Notify(c.ctx, n.method, n.params)
}
