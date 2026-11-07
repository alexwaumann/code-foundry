package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
)

// The DevTools protocol over --remote-debugging-pipe: JSON messages, each ended by a NUL
// byte, on two inherited file descriptors. There is no listener of any kind, which is the
// point: nothing else on this Mac can drive a browser that holds the user's logins.

// maxMessage bounds one message from Chrome. A screencast frame is its biggest, a few MB of
// base64. A page can make far bigger ones (console.log of a long string) and must not end the
// connection by it, so anything past this is read to its end and skipped, and the daemon never
// holds more of it than this. keepBuffer is how much of such a buffer stays for the next one.
const (
	maxMessage = 32 << 20
	keepBuffer = 2 << 20
	headBytes  = 64
)

// writeQueue is how many messages may wait for the pipe. Calls wait for room under their own
// context; a frame's ack that finds no room is dropped, and Chrome only sends fewer frames.
const writeQueue = 256

// ErrChromeGone is the error of a call whose Chrome has stopped.
var ErrChromeGone = errors.New("chrome has stopped")

// errTooLong is a message past maxMessage, and the error of a call whose reply was one.
var errTooLong = errors.New("chrome's message is too long")

// replyHead reads which call a skipped reply answers: Chrome writes the id first.
var replyHead = regexp.MustCompile(`^\{"id":(\d+)[,}]`)

// ignored are the events nothing here reads and a page makes as often and as long as it likes.
// Runtime.enable has to stay on: without it Runtime.addBinding does nothing, and the helper's
// reports never arrive (measured on Chrome 157, enabling and disabling again included).
var ignored = [][]byte{
	[]byte(`{"method":"Runtime.consoleAPICalled"`),
	[]byte(`{"method":"Runtime.exceptionThrown"`),
}

// remoteError is an error Chrome answered a call with. Its message may quote a page's
// URL, so it goes to a viewer and never to the log above debug level.
type remoteError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *remoteError) Error() string { return fmt.Sprintf("chrome: %s (%d)", e.Message, e.Code) }

// message is one frame of the protocol, either way. Replies have ID, events Method.
type message struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *remoteError    `json:"error,omitempty"`
}

// reply is what a Call waits for.
type reply struct {
	result json.RawMessage
	err    error
}

// conn is one DevTools connection. Events reach onEvent on the reader's goroutine, in order,
// so onEvent must never wait for a reply: that reply comes through the same goroutine.
type conn struct {
	in  io.Closer // what writes to Chrome; closing it is what tells Chrome to exit
	out chan []byte

	onEvent func(method, session string, params json.RawMessage)
	onGone  func(error)

	next atomic.Int64

	mu      sync.Mutex
	waiting map[int64]chan reply
	gone    error
	done    chan struct{}
}

// newConn starts the reader and the writer over Chrome's two pipe ends.
func newConn(toChrome io.WriteCloser, fromChrome io.Reader, onEvent func(string, string, json.RawMessage), onGone func(error)) *conn {
	c := &conn{
		in: toChrome, out: make(chan []byte, writeQueue), onEvent: onEvent, onGone: onGone,
		waiting: map[int64]chan reply{}, done: make(chan struct{}),
	}
	go c.read(fromChrome)
	go c.write(toChrome)
	return c
}

// write owns the pipe's write end. A Chrome that stopped reading blocks it here, never a
// caller, whose context ends the wait.
func (c *conn) write(w io.Writer) {
	for {
		select {
		case <-c.done:
			return
		case b := <-c.out:
			if _, err := w.Write(b); err != nil {
				c.fail(fmt.Errorf("%w: %w", ErrChromeGone, err))
				return
			}
		}
	}
}

// read owns the pipe's read end until it ends.
func (c *conn) read(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	var long bytes.Buffer
	for {
		if long.Cap() > keepBuffer {
			long = bytes.Buffer{}
		}
		b, err := readMessage(br, &long)
		if errors.Is(err, errTooLong) {
			c.skip(long.Bytes())
			continue
		}
		if err != nil {
			c.fail(fmt.Errorf("%w: %w", ErrChromeGone, err))
			return
		}
		if slices.ContainsFunc(ignored, func(p []byte) bool { return bytes.HasPrefix(b, p) }) {
			continue
		}
		var m message
		if err := json.Unmarshal(b, &m); err != nil {
			continue // not ours to act on; a call it answered times out
		}
		if m.ID != 0 {
			c.settle(m)
			continue
		}
		if m.Method != "" {
			c.onEvent(m.Method, m.SessionID, m.Params)
		}
	}
}

// readMessage reads up to the next NUL, without it. The slice is valid until the next call. A
// message past maxMessage is read to its NUL and dropped: the answer is errTooLong, and long
// keeps its first bytes.
func readMessage(br *bufio.Reader, long *bytes.Buffer) ([]byte, error) {
	long.Reset()
	for {
		part, err := br.ReadSlice(0)
		if err == nil && long.Len() == 0 {
			return part[:len(part)-1], nil
		}
		long.Write(part)
		if long.Len() > maxMessage {
			long.Truncate(headBytes)
			return nil, discard(br, err)
		}
		if err == nil {
			return long.Bytes()[:long.Len()-1], nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// discard reads past the next NUL; err is how the last read ended.
func discard(br *bufio.Reader, err error) error {
	for errors.Is(err, bufio.ErrBufferFull) {
		_, err = br.ReadSlice(0)
	}
	if err != nil {
		return err
	}
	return errTooLong
}

// skip deals with a message nobody will read. A reply fails its call at once rather than leave
// it to time out; an event is just gone.
func (c *conn) skip(head []byte) {
	m := replyHead.FindSubmatch(head)
	if m == nil {
		return
	}
	id, err := strconv.ParseInt(string(m[1]), 10, 64)
	if err != nil {
		return
	}
	c.mu.Lock()
	ch := c.waiting[id]
	delete(c.waiting, id)
	c.mu.Unlock()
	if ch != nil {
		ch <- reply{err: errTooLong}
	}
}

func (c *conn) settle(m message) {
	c.mu.Lock()
	ch := c.waiting[m.ID]
	delete(c.waiting, m.ID)
	c.mu.Unlock()
	if ch == nil {
		return // a call that stopped waiting
	}
	if m.Error != nil {
		ch <- reply{err: m.Error}
		return
	}
	// The reader reuses its buffer, and Result points into it.
	ch <- reply{result: bytes.Clone(m.Result)}
}

// fail ends the connection once: every waiting call gets err, and so does onGone.
func (c *conn) fail(err error) {
	c.mu.Lock()
	if c.gone != nil {
		c.mu.Unlock()
		return
	}
	c.gone = err
	waiting := c.waiting
	c.waiting = map[int64]chan reply{}
	close(c.done)
	c.mu.Unlock()
	for _, ch := range waiting {
		ch <- reply{err: err}
	}
	_ = c.in.Close()
	if c.onGone != nil {
		c.onGone(err)
	}
}

// close ends the connection. Closing Chrome's read end is also what makes it exit.
func (c *conn) close() { c.fail(ErrChromeGone) }

func encode(id int64, session, method string, params any) ([]byte, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", method, err)
	}
	b, err := json.Marshal(message{ID: id, Method: method, Params: raw, SessionID: session})
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", method, err)
	}
	return append(b, 0), nil
}

// call sends method to session ("" is the browser) and decodes the reply into out, which may
// be nil. It ends with ctx, and the reply is then ignored.
func (c *conn) call(ctx context.Context, session, method string, params, out any) error {
	if params == nil {
		params = struct{}{}
	}
	id := c.next.Add(1)
	b, err := encode(id, session, method, params)
	if err != nil {
		return err
	}
	ch := make(chan reply, 1)
	c.mu.Lock()
	if c.gone != nil {
		err := c.gone
		c.mu.Unlock()
		return err
	}
	c.waiting[id] = ch
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.waiting, id)
		c.mu.Unlock()
	}
	select {
	case c.out <- b:
	case <-ctx.Done():
		forget()
		return fmt.Errorf("%s: %w", method, ctx.Err())
	case <-c.done:
		forget()
		return c.goneErr()
	}
	select {
	case r := <-ch:
		if r.err != nil {
			return fmt.Errorf("%s: %w", method, r.err)
		}
		if out == nil {
			return nil
		}
		if err := json.Unmarshal(r.result, out); err != nil {
			return fmt.Errorf("%s: decode reply: %w", method, err)
		}
		return nil
	case <-ctx.Done():
		forget()
		return fmt.Errorf("%s: %w", method, ctx.Err())
	}
}

// post sends method without waiting for a reply or for room: the frame acks, which the
// reader's goroutine sends, and which must never wait there.
func (c *conn) post(session, method string, params any) {
	b, err := encode(c.next.Add(1), session, method, params)
	if err != nil {
		return
	}
	select {
	case c.out <- b:
	default:
	}
}

func (c *conn) goneErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gone
}
