package pluginsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// pair connects two Conns over pipes.
func pair(t *testing.T, a, b ConnOptions) (*Conn, *Conn) {
	t.Helper()
	ar, bw := io.Pipe()
	br, aw := io.Pipe()
	ca := NewConn(ar, aw, a)
	cb := NewConn(br, bw, b)
	t.Cleanup(func() {
		_ = ca.Close()
		_ = cb.Close()
		_ = aw.Close()
		_ = bw.Close()
	})
	return ca, cb
}

func ctxT(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestConnCall(t *testing.T) {
	server := ConnOptions{Handle: func(_ context.Context, method string, params json.RawMessage) (any, error) {
		switch method {
		case "echo":
			var s string
			_ = json.Unmarshal(params, &s)
			return s + "!", nil
		case "denied":
			return nil, NewError(CodePermissionDenied, "no")
		case "boom":
			return nil, errors.New("plain error")
		case "wrapped":
			return nil, fmt.Errorf("sending the log: %w", NewError(CodePermissionDenied, "permission denied: command thread.send"))
		case "panic":
			panic("oops")
		}
		return nil, NewError(CodeMethodNotFound, "unknown %s", method)
	}}
	client, _ := pair(t, ConnOptions{}, server)
	ctx := ctxT(t)

	var out string
	if err := client.Call(ctx, "echo", "hi", &out); err != nil || out != "hi!" {
		t.Fatalf("echo = %q, %v", out, err)
	}
	tests := []struct {
		method string
		code   int
		msg    string
	}{
		{"denied", CodePermissionDenied, "no"},
		{"boom", CodeInternal, "plain error"},
		{"wrapped", CodePermissionDenied, "sending the log: permission denied: command thread.send"},
		{"panic", CodeInternal, "panic: internal error"},
		{"nope", CodeMethodNotFound, "unknown nope"},
	}
	for _, tt := range tests {
		err := client.Call(ctx, tt.method, nil, nil)
		if got := ErrorCode(err); got != tt.code || err.Error() != tt.msg {
			t.Errorf("%s: code %d (%q), want %d (%q)", tt.method, got, err, tt.code, tt.msg)
		}
	}
}

func TestConnNotificationsInOrder(t *testing.T) {
	var mu sync.Mutex
	var got []string
	done := make(chan struct{})
	server := ConnOptions{Notify: func(_ context.Context, method string, params json.RawMessage) {
		mu.Lock()
		defer mu.Unlock()
		var s string
		_ = json.Unmarshal(params, &s)
		got = append(got, s)
		if len(got) == 100 {
			close(done)
		}
	}}
	client, _ := pair(t, ConnOptions{}, server)
	for i := range 100 {
		if err := client.Notify("n", strings.Repeat("x", i)); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("notifications did not arrive")
	}
	for i, s := range got {
		if len(s) != i {
			t.Fatalf("notification %d out of order: len %d", i, len(s))
		}
	}
}

func TestConnOversizeLineSkipped(t *testing.T) {
	r, w := io.Pipe()
	issues := make(chan string, 4)
	got := make(chan string, 4)
	c := NewConn(r, io.Discard, ConnOptions{
		MaxLine: 64,
		OnIssue: func(m string) { issues <- m },
		Notify: func(_ context.Context, method string, _ json.RawMessage) {
			got <- method
		},
	})
	defer func() { _ = c.Close() }()
	go func() {
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"`+strings.Repeat("a", 100)+`"}`+"\n")
		_, _ = io.WriteString(w, "not json\n")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"ok"}`+"\n")
	}()
	select {
	case m := <-got:
		if m != "ok" {
			t.Fatalf("got %q", m)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no notification")
	}
	if m := <-issues; !strings.Contains(m, "over the 64 byte limit") {
		t.Errorf("issue %q", m)
	}
	if m := <-issues; !strings.Contains(m, "malformed") {
		t.Errorf("issue %q", m)
	}
	_ = w.Close()
	<-c.Done()
	if !errors.Is(c.Err(), io.EOF) {
		t.Errorf("Err = %v, want EOF", c.Err())
	}
}

func TestConnQueueFullWhenPeerStopsReading(t *testing.T) {
	r, _ := io.Pipe() // never written
	_, w := io.Pipe() // never read: the first write blocks
	c := NewConn(r, w, ConnOptions{MaxQueue: 1024})
	defer func() { _ = c.Close() }()
	var err error
	for range 100 {
		if err = c.Notify("n", strings.Repeat("x", 100)); err != nil {
			break
		}
	}
	if !errors.Is(err, ErrQueueFull) {
		t.Fatalf("err = %v, want ErrQueueFull", err)
	}
}

func TestConnPendingCallsFailOnClose(t *testing.T) {
	block := make(chan struct{})
	server := ConnOptions{Handle: func(ctx context.Context, _ string, _ json.RawMessage) (any, error) {
		<-block
		return nil, nil
	}}
	client, _ := pair(t, ConnOptions{}, server)
	defer close(block)
	errc := make(chan error, 1)
	go func() { errc <- client.Call(context.Background(), "slow", nil, nil) }()
	time.Sleep(50 * time.Millisecond)
	_ = client.Close()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("err = %v, want ErrClosed", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("call did not fail")
	}
	if err := client.Call(context.Background(), "x", nil, nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("after close: %v", err)
	}
}

func TestConnCallContextCancel(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	client, _ := pair(t, ConnOptions{}, ConnOptions{Handle: func(context.Context, string, json.RawMessage) (any, error) {
		<-block
		return nil, nil
	}})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := client.Call(ctx, "slow", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
}
