package claudestream

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeCLI is the other end of a Conn: tests write the CLI's stdout lines and read
// what the Conn wrote to stdin.
type fakeCLI struct {
	t      *testing.T
	out    *io.PipeWriter // CLI stdout
	in     *bufio.Scanner // CLI stdin
	inR    *io.PipeReader
	conn   *Conn
	closed chan struct{}
}

func newFakeCLI(t *testing.T, opts Options) *fakeCLI {
	t.Helper()
	outR, outW := io.Pipe()
	inR, inW := io.Pipe()
	f := &fakeCLI{t: t, out: outW, inR: inR, in: bufio.NewScanner(inR), closed: make(chan struct{})}
	f.in.Buffer(nil, 1<<20)
	f.conn = NewConn(outR, inW, opts)
	t.Cleanup(func() {
		_ = outW.Close()
		_ = inR.Close()
		f.conn.Close()
	})
	return f
}

func (f *fakeCLI) emit(line string) {
	f.t.Helper()
	if _, err := io.WriteString(f.out, line+"\n"); err != nil {
		f.t.Fatal(err)
	}
}

// read returns the next line the Conn wrote, decoded.
func (f *fakeCLI) read() map[string]any {
	f.t.Helper()
	if !f.in.Scan() {
		f.t.Fatalf("stdin ended: %v", f.in.Err())
	}
	var m map[string]any
	if err := json.Unmarshal(f.in.Bytes(), &m); err != nil {
		f.t.Fatal(err)
	}
	return m
}

func next(t *testing.T, c *Conn) Event {
	t.Helper()
	select {
	case ev, ok := <-c.Events():
		if !ok {
			t.Fatal("events closed")
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
	}
	return nil
}

func TestConnRequestCorrelation(t *testing.T) {
	f := newFakeCLI(t, Options{})
	ctx := context.Background()
	// One channel per request: the answers come out of order, so which caller wakes
	// first is up to the scheduler.
	initErr, modeErr := make(chan error, 1), make(chan error, 1)
	go func() {
		r, err := f.conn.Initialize(ctx)
		if err == nil && (r.PID != 42 || r.CurrentPermissionMode != "default") {
			err = errors.New("bad initialize response")
		}
		initErr <- err
	}()
	init := f.read()
	if init["type"] != "control_request" || init["request"].(map[string]any)["subtype"] != "initialize" {
		t.Fatalf("first line %v", init)
	}
	go func() {
		modeErr <- f.conn.SetPermissionMode(ctx, "bogus")
	}()
	mode := f.read()
	// Answer out of order: the second request first.
	f.emit(`{"type":"control_response","response":{"subtype":"error","request_id":"` + mode["request_id"].(string) + `","error":"Cannot set permission mode"}}`)
	f.emit(`{"type":"stream_event","event":{"type":"message_stop"}}`)
	f.emit(`{"type":"control_response","response":{"subtype":"success","request_id":"` + init["request_id"].(string) + `","response":{"pid":42,"current_permission_mode":"default"}}}`)
	errs := []error{<-modeErr, <-initErr}
	var ce *ControlError
	if !errors.As(errs[0], &ce) || ce.Subtype != "set_permission_mode" || !strings.Contains(ce.Error(), "Cannot set") {
		t.Errorf("set mode err = %v", errs[0])
	}
	if errs[1] != nil {
		t.Errorf("initialize err = %v", errs[1])
	}
	// Responses never reach Events; the stream event does.
	if ev := next(t, f.conn); kindOf(ev) != "stream:message_stop" {
		t.Errorf("event %s", kindOf(ev))
	}

	// stdout ends: a waiting request fails with ErrClosed, Events closes.
	errc := make(chan error, 1)
	go func() { errc <- f.conn.Interrupt(ctx) }()
	f.read()
	_ = f.out.Close()
	if err := <-errc; !errors.Is(err, ErrClosed) {
		t.Errorf("interrupt after close: %v", err)
	}
	if _, ok := <-f.conn.Events(); ok {
		t.Error("events still open")
	}
	if err := f.conn.Interrupt(ctx); !errors.Is(err, ErrClosed) {
		t.Errorf("request after close: %v", err)
	}
}

func TestConnSendAndCloseStdin(t *testing.T) {
	f := newFakeCLI(t, Options{})
	go func() {
		_ = f.conn.Send(context.Background(), UserMessage{UUID: "u-1", Blocks: []ContentBlock{TextBlock("hi"), ImageBlock("image/png", "AAAA"), DocumentBlock("application/pdf", "JVBE")}})
	}()
	m := f.read()
	b, _ := json.Marshal(m)
	want := `{"message":{"content":[{"text":"hi","type":"text"},{"source":{"data":"AAAA","media_type":"image/png","type":"base64"},"type":"image"},{"source":{"data":"JVBE","media_type":"application/pdf","type":"base64"},"type":"document"}],"role":"user"},"parent_tool_use_id":null,"type":"user","uuid":"u-1"}`
	if string(b) != want {
		t.Errorf("user line\n got %s\nwant %s", b, want)
	}
	if err := f.conn.Send(context.Background(), UserMessage{}); err == nil {
		t.Error("empty message accepted")
	}
	if err := f.conn.CloseStdin(); err != nil {
		t.Fatal(err)
	}
	if f.in.Scan() {
		t.Error("stdin still open")
	}
	if err := f.conn.Send(context.Background(), UserMessage{Blocks: []ContentBlock{TextBlock("x")}}); !errors.Is(err, ErrClosed) {
		t.Errorf("send after close: %v", err)
	}
}

// A CLI that exited before reading its stdin fails a write with ErrClosed, as a CLI
// whose stdout ended does: the caller learns the process is gone, not a pipe error.
func TestConnWriteToGoneCLI(t *testing.T) {
	tests := []struct {
		name string
		// pipe is the CLI's stdin with its reader gone.
		pipe func(t *testing.T) io.WriteCloser
	}{
		{"reader exited (EPIPE)", func(t *testing.T) io.WriteCloser {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			_ = r.Close()
			t.Cleanup(func() { _ = w.Close() })
			return w
		}},
		{"pipe closed after the exit", func(t *testing.T) io.WriteCloser {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			_ = r.Close()
			_ = w.Close()
			return w
		}},
		{"in-process pipe", func(*testing.T) io.WriteCloser {
			r, w := io.Pipe()
			_ = r.Close()
			return w
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			outR, outW := io.Pipe()
			c := NewConn(outR, tt.pipe(t), Options{})
			t.Cleanup(func() {
				_ = outW.Close()
				c.Close()
			})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := c.Initialize(ctx); !errors.Is(err, ErrClosed) {
				t.Errorf("initialize: %v", err)
			}
			if err := c.Send(ctx, UserMessage{Blocks: []ContentBlock{TextBlock("x")}}); !errors.Is(err, ErrClosed) {
				t.Errorf("send: %v", err)
			}
		})
	}
}

// TestConnReplay feeds each captured session through a Conn and checks the
// permission requests delivered on Events and the answers written.
func TestConnReplay(t *testing.T) {
	tests := []struct {
		name string
		// decide is the handler's answer.
		decide func(*PermissionRequest) PermissionResult
		check  func(t *testing.T, reqs []*PermissionRequest, answers []map[string]any)
	}{
		{
			name:   "write-allow",
			decide: func(*PermissionRequest) PermissionResult { return PermissionResult{Allow: true} },
			check: func(t *testing.T, reqs []*PermissionRequest, answers []map[string]any) {
				r := reqs[0]
				if r.ToolName != "Write" || r.ToolUseID == "" || r.Description != "hello.txt" || !strings.Contains(string(r.Input), "hello.txt") || !strings.Contains(string(r.Suggestions), "acceptEdits") {
					t.Errorf("request %+v", r)
				}
				resp := answers[0]["response"].(map[string]any)
				inner := resp["response"].(map[string]any)
				if resp["request_id"] != r.RequestID || inner["behavior"] != "allow" || inner["updatedInput"].(map[string]any)["content"] != "hi" {
					t.Errorf("answer %v", answers[0])
				}
			},
		},
		{
			name:   "write-deny",
			decide: func(*PermissionRequest) PermissionResult { return PermissionResult{Message: "The user denied this."} },
			check: func(t *testing.T, _ []*PermissionRequest, answers []map[string]any) {
				inner := answers[0]["response"].(map[string]any)["response"].(map[string]any)
				if inner["behavior"] != "deny" || inner["message"] != "The user denied this." {
					t.Errorf("answer %v", answers[0])
				}
			},
		},
		{
			name: "ask",
			decide: func(r *PermissionRequest) PermissionResult {
				var in struct {
					Questions json.RawMessage `json:"questions"`
				}
				_ = json.Unmarshal(r.Input, &in)
				up, _ := json.Marshal(map[string]any{"questions": in.Questions, "answers": map[string]string{"Which color do you prefer?": "Red"}})
				return PermissionResult{Allow: true, UpdatedInput: up}
			},
			check: func(t *testing.T, reqs []*PermissionRequest, answers []map[string]any) {
				if !reqs[0].IsQuestion() || !reqs[0].RequiresUserInteraction {
					t.Errorf("request %+v", reqs[0])
				}
				inner := answers[0]["response"].(map[string]any)["response"].(map[string]any)
				if inner["updatedInput"].(map[string]any)["answers"].(map[string]any)["Which color do you prefer?"] != "Red" {
					t.Errorf("answer %v", inner)
				}
			},
		},
		{
			name:   "task",
			decide: func(*PermissionRequest) PermissionResult { return PermissionResult{Allow: true} },
			check: func(t *testing.T, reqs []*PermissionRequest, _ []map[string]any) {
				if reqs[0].AgentID == "" || reqs[0].ToolName != "Write" {
					t.Errorf("subagent request %+v", reqs[0])
				}
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var mu sync.Mutex
			var reqs []*PermissionRequest
			f := newFakeCLI(t, Options{})
			go func() {
				for ev := range f.conn.Events() {
					if r, ok := ev.(*PermissionRequest); ok {
						mu.Lock()
						reqs = append(reqs, r)
						mu.Unlock()
						if err := r.Answer(tt.decide(r)); err != nil {
							t.Errorf("answer: %v", err)
						}
					}
				}
			}()
			lines := fixture(t, tt.name)
			var answers []map[string]any
			for _, l := range lines {
				f.emit(string(l))
				if strings.Contains(string(l), `"subtype":"can_use_tool"`) {
					answers = append(answers, f.read())
				}
			}
			mu.Lock()
			defer mu.Unlock()
			if len(reqs) != 1 || len(answers) != 1 {
				t.Fatalf("requests %d answers %d", len(reqs), len(answers))
			}
			tt.check(t, reqs, answers)
		})
	}
}

// TestConnPermissionOrder: a can_use_tool request is delivered after the lines the
// CLI wrote before it (the assistant frame carrying its tool_use), every time.
func TestConnPermissionOrder(t *testing.T) {
	f := newFakeCLI(t, Options{})
	const n = 200
	go func() {
		for i := range n {
			f.emit(fmt.Sprintf(`{"type":"assistant","message":{"id":"m%d","role":"assistant","content":[{"type":"tool_use","id":"t%d","name":"Bash","input":{}}]},"parent_tool_use_id":null}`, i, i))
			f.emit(fmt.Sprintf(`{"type":"control_request","request_id":"p%d","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t%d"}}`, i, i))
		}
	}()
	for i := range n {
		a, ok := next(t, f.conn).(*Assistant)
		if !ok || a.Message.Content[0].ID != fmt.Sprintf("t%d", i) {
			t.Fatalf("pair %d: expected the assistant frame first, got %T", i, a)
		}
		r, ok := next(t, f.conn).(*PermissionRequest)
		if !ok || r.RequestID != fmt.Sprintf("p%d", i) || r.ToolUseID != fmt.Sprintf("t%d", i) || !strings.Contains(string(r.RawJSON()), "can_use_tool") {
			t.Fatalf("pair %d: expected its request, got %+v", i, r)
		}
	}
}

func TestConnPermissionCancelled(t *testing.T) {
	f := newFakeCLI(t, Options{})
	evs := make(chan Event, 1024)
	go func() {
		for ev := range f.conn.Events() {
			evs <- ev
		}
		close(evs)
	}()
	var req *PermissionRequest
	var cancelSeen bool
	for _, l := range fixture(t, "interrupt-pending") {
		f.emit(string(l))
	}
	for ev := range evs {
		switch e := ev.(type) {
		case *PermissionRequest:
			req = e
		case *ControlCancel:
			if req == nil || e.RequestID != req.RequestID {
				t.Fatalf("cancel %q before its request %+v", e.RequestID, req)
			}
			cancelSeen = true
		}
		if cancelSeen {
			break
		}
	}
	if !cancelSeen {
		t.Fatal("fixture has no cancel")
	}
	// Withdrawn: answering sends nothing.
	if err := req.Answer(PermissionResult{Allow: true}); !errors.Is(err, ErrCancelled) {
		t.Errorf("answer after withdrawal: %v", err)
	}
	// Nothing was answered: the next thing on stdin is EOF once the conn closes stdin.
	_ = f.conn.CloseStdin()
	if f.in.Scan() {
		t.Errorf("unexpected answer %s", f.in.Text())
	}
}

func TestConnPermissionOnExit(t *testing.T) {
	f := newFakeCLI(t, Options{})
	f.emit(`{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"},"tool_use_id":"t1"}}`)
	req, ok := next(t, f.conn).(*PermissionRequest)
	if !ok {
		t.Fatal("no request")
	}
	_ = f.out.Close()
	for range f.conn.Events() {
	}
	if err := req.Answer(PermissionResult{Allow: true}); !errors.Is(err, ErrClosed) {
		t.Errorf("answer after exit: %v", err)
	}
}

func TestConnUnsupportedRequest(t *testing.T) {
	f := newFakeCLI(t, Options{})
	f.emit(`{"type":"control_request","request_id":"d1","request":{"subtype":"request_user_dialog","dialog_kind":"x"}}`)
	m := f.read()
	resp := m["response"].(map[string]any)
	if resp["subtype"] != "error" || resp["request_id"] != "d1" {
		t.Errorf("answer %v", m)
	}
	// can_use_tool is the consumer's: answered once, a second answer refused.
	f.emit(`{"type":"control_request","request_id":"p1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{},"tool_use_id":"t1"}}`)
	req, ok := next(t, f.conn).(*PermissionRequest)
	if !ok {
		t.Fatal("no request")
	}
	if err := req.Answer(PermissionResult{Message: "no"}); err != nil {
		t.Fatal(err)
	}
	inner := f.read()["response"].(map[string]any)["response"].(map[string]any)
	if inner["behavior"] != "deny" || inner["message"] != "no" {
		t.Errorf("answer %v", inner)
	}
	if err := req.Answer(PermissionResult{Allow: true}); !errors.Is(err, ErrAnswered) {
		t.Errorf("second answer: %v", err)
	}
}

// TestRealClaudeStream drives the real CLI: initialize, a Write that needs
// permission (allowed), the file on disk, then an idle exit on stdin close. Skipped
// unless CF_REAL_CLAUDE=1 (uses haiku, a few cents).
func TestRealClaudeStream(t *testing.T) {
	if os.Getenv("CF_REAL_CLAUDE") != "1" {
		t.Skip("CF_REAL_CLAUDE != 1")
	}
	dir := t.TempDir()
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if k == "CLAUDECODE" || strings.HasPrefix(k, "CLAUDE_CODE_") || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" || k == "CLAUDE_AGENT_SDK_VERSION" {
			env = append(env, k) // bare key: removed
		}
	}
	p, err := Start(Spec{
		Argv: []string{"claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
			"--include-partial-messages", "--permission-prompt-tool", "stdio", "--model", "haiku", "--effort", "low",
			"--permission-mode", "manual"},
		Env: env, Dir: dir,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	c := p.Conn()
	ir, err := c.Initialize(ctx)
	if err != nil {
		t.Fatalf("initialize: %v (stderr %s)", err, p.Stderr())
	}
	if ir.PID != p.Pid() {
		t.Errorf("initialize pid %d, process %d", ir.PID, p.Pid())
	}
	if err := c.Send(ctx, UserMessage{Blocks: []ContentBlock{TextBlock("Create a file named hello.txt containing exactly hi using the Write tool. Then say done.")}}); err != nil {
		t.Fatal(err)
	}
	var result *Result
	var asked []string
	for result == nil {
		select {
		case ev, ok := <-c.Events():
			if !ok {
				t.Fatalf("stream ended (stderr %s)", p.Stderr())
			}
			switch e := ev.(type) {
			case *Result:
				result = e
			case *PermissionRequest:
				asked = append(asked, e.ToolName)
				if err := e.Answer(PermissionResult{Allow: true}); err != nil {
					t.Fatal(err)
				}
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if result.IsError {
		t.Errorf("result %+v", result)
	}
	if len(asked) == 0 || asked[0] != "Write" {
		t.Errorf("asked about %v", asked)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "hello.txt")); err != nil || strings.TrimSpace(string(b)) != "hi" {
		t.Errorf("hello.txt = %q, %v", b, err)
	}
	_ = c.CloseStdin()
	select {
	case <-p.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("did not exit after stdin closed")
	}
	if p.ExitCode() != 0 {
		t.Errorf("exit %d (stderr %s)", p.ExitCode(), p.Stderr())
	}
}
