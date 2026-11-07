// Package browsertest is a fake Chrome for the browser store: a Process that speaks the
// DevTools pipe protocol in memory, answers what it is told to, records every call, and sends
// the events a test scripts. Tests that need the real thing use the system Chrome instead and
// skip without it.
package browsertest

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/browser"
)

// Call is one protocol call the fake took.
type Call struct {
	Method, Session string
	Params          map[string]any
}

// Chrome is a fake browser. Its zero value is not usable: see New.
type Chrome struct {
	mu       sync.Mutex
	calls    []Call
	replies  map[string]func(Call) (any, error)
	next     int
	launches int
	failure  error
	silent   bool
	blame    func() bool

	proc *process
}

// New returns a fake with answers for the calls a surface makes.
func New() *Chrome {
	c := &Chrome{replies: map[string]func(Call) (any, error){}}
	c.Reply("Target.createTarget", func(Call) (any, error) {
		c.next++
		return map[string]string{"targetId": fmt.Sprintf("target-%d", c.next)}, nil
	})
	c.Reply("Target.attachToTarget", func(call Call) (any, error) {
		return map[string]string{"sessionId": "session-" + fmt.Sprint(call.Params["targetId"])}, nil
	})
	c.Reply("Browser.getVersion", func(Call) (any, error) { return map[string]string{"product": "Fake/1"}, nil })
	c.Reply("Page.createIsolatedWorld", func(Call) (any, error) { return map[string]int{"executionContextId": 7}, nil })
	c.Reply("Page.getNavigationHistory", func(Call) (any, error) {
		return map[string]any{"currentIndex": 0, "entries": []map[string]any{{"id": 1}}}, nil
	})
	return c
}

// Reply sets the answer to a method; anything without one answers {}.
func (c *Chrome) Reply(method string, f func(Call) (any, error)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.replies[method] = f
}

// FailLaunch makes every launch fail with err.
func (c *Chrome) FailLaunch(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failure = err
}

// Silent makes the fake a Chrome that never answers its pipe.
func (c *Chrome) Silent() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.silent = true
}

// Launches counts the processes started.
func (c *Chrome) Launches() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.launches
}

// Launch is the store's Launcher.
func (c *Chrome) Launch(context.Context, string) (browser.Process, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failure != nil {
		return nil, c.failure
	}
	c.launches++
	p := newProcess(c)
	c.proc = p
	return p, nil
}

// Calls are the calls of method so far, all of them for "".
func (c *Chrome) Calls(method string) []Call {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Call
	for _, x := range c.calls {
		if method == "" || x.Method == method {
			out = append(out, x)
		}
	}
	return out
}

// Emit sends an event, session "" for the browser.
func (c *Chrome) Emit(method, session string, params any) {
	c.mu.Lock()
	p := c.proc
	c.mu.Unlock()
	raw, _ := json.Marshal(params)
	b, _ := json.Marshal(map[string]any{"method": method, "sessionId": session, "params": json.RawMessage(raw)})
	p.send(b)
}

// Frame sends a screencast frame numbered id.
func (c *Chrome) Frame(session string, id int, data []byte, width, height int) {
	c.Emit("Page.screencastFrame", session, map[string]any{
		"data": base64.StdEncoding.EncodeToString(data), "sessionId": id,
		"metadata": map[string]any{"deviceWidth": width, "deviceHeight": height},
	})
}

// Crash ends the process the way a crash does: the pipe closes and it is gone.
func (c *Chrome) Crash() {
	c.mu.Lock()
	p := c.proc
	c.mu.Unlock()
	p.exit()
}

// Stopped reports whether the last process has exited.
func (c *Chrome) Stopped() bool {
	c.mu.Lock()
	p := c.proc
	c.mu.Unlock()
	if p == nil {
		return true
	}
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

func (c *Chrome) answer(call Call) (any, error) {
	c.mu.Lock()
	c.calls = append(c.calls, call)
	f := c.replies[call.Method]
	silent := c.silent
	c.mu.Unlock()
	if silent {
		return nil, errSilent
	}
	if f == nil {
		return map[string]any{}, nil
	}
	return f(call)
}

var errSilent = fmt.Errorf("silent")

type process struct {
	c        *Chrome
	toChrome *io.PipeWriter
	in       *io.PipeReader
	from     *io.PipeReader
	out      *io.PipeWriter
	done     chan struct{}
	once     sync.Once
	wmu      sync.Mutex
}

func newProcess(c *Chrome) *process {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &process{c: c, toChrome: inW, in: inR, from: outR, out: outW, done: make(chan struct{})}
	go p.serve()
	return p
}

func (p *process) send(b []byte) {
	p.wmu.Lock()
	defer p.wmu.Unlock()
	_, _ = p.out.Write(append(b, 0))
}

func (p *process) serve() {
	br := bufio.NewReader(p.in)
	for {
		b, err := br.ReadBytes(0)
		if err != nil {
			p.exit() // like Chrome: the pipe closing is the order to exit
			return
		}
		var m struct {
			ID        int64          `json:"id"`
			Method    string         `json:"method"`
			Params    map[string]any `json:"params"`
			SessionID string         `json:"sessionId"`
		}
		if json.Unmarshal(b[:len(b)-1], &m) != nil {
			continue
		}
		res, err := p.c.answer(Call{Method: m.Method, Session: m.SessionID, Params: m.Params})
		if err == errSilent {
			continue
		}
		reply := map[string]any{"id": m.ID}
		if err != nil {
			reply["error"] = map[string]any{"code": -32000, "message": err.Error()}
		} else {
			reply["result"] = res
		}
		out, _ := json.Marshal(reply)
		go p.send(out)
	}
}

func (p *process) exit() {
	p.once.Do(func() {
		close(p.done)
		_ = p.out.Close()
		_ = p.in.Close()
	})
}

func (p *process) Pipes() (io.WriteCloser, io.Reader) { return p.toChrome, p.from }
func (p *process) Done() <-chan struct{}              { return p.done }
func (p *process) Stop()                              { p.exit() }
func (p *process) Tail() string                       { return "" }

// BlameWith keeps what the store answers a swell with (browser.Blamer).
func (p *process) BlameWith(f func() bool) {
	p.c.mu.Lock()
	defer p.c.mu.Unlock()
	p.c.blame = f
}

// Swell is Chrome's own process growing, as the memory watch would see it: it asks the store,
// and reports whether a page was closed. False with no store wired to the process.
func (c *Chrome) Swell() bool {
	c.mu.Lock()
	f := c.blame
	c.mu.Unlock()
	return f != nil && f()
}
