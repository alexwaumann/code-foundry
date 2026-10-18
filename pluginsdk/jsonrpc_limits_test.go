package pluginsdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// issues collects OnIssue messages.
type issues struct {
	mu  sync.Mutex
	all []string
}

func (i *issues) add(m string) { i.mu.Lock(); i.all = append(i.all, m); i.mu.Unlock() }
func (i *issues) has(sub string) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	for _, m := range i.all {
		if strings.Contains(m, sub) {
			return true
		}
	}
	return false
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// A peer flooding notifications while Notify is busy fills a bounded queue; the rest
// are dropped and reported, once per burst.
func TestConnBoundsTheNotificationQueue(t *testing.T) {
	release := make(chan struct{})
	var handled atomic.Int32
	iss := &issues{}
	r, w := io.Pipe()
	c := NewConn(r, io.Discard, ConnOptions{
		Notify: func(context.Context, string, json.RawMessage) {
			<-release
			handled.Add(1)
		},
		OnIssue: iss.add,
	})
	defer func() { _ = c.Close() }()
	const sent = MaxNotifications + 500
	go func() {
		for range sent {
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"n","params":{}}`+"\n")
		}
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","method":"last"}`+"\n")
	}()
	waitFor(t, "a drop", func() bool { return iss.has("dropping notifications") })
	close(release)
	waitFor(t, "the queue to drain", func() bool { return iss.has("dropped") && iss.has("notifications while the queue was full") })
	waitFor(t, "the last notification", func() bool { return handled.Load() > MaxNotifications })
	if n := handled.Load(); n >= sent || n < MaxNotifications {
		t.Errorf("handled %d of %d", n, sent)
	}
	n := 0
	for _, m := range iss.all {
		if strings.Contains(m, "dropping notifications") {
			n++
		}
	}
	if n != 1 {
		t.Errorf("the drop was reported %d times", n)
	}
	_ = w.Close()
}

// A peer flooding requests while handlers block gets CodeRateLimited answers at once for
// those over MaxInflight; the rest are answered when the handlers return.
func TestConnBoundsRequestsInFlight(t *testing.T) {
	release := make(chan struct{})
	server := ConnOptions{Handle: func(ctx context.Context, _ string, _ json.RawMessage) (any, error) {
		select {
		case <-release:
		case <-ctx.Done():
		}
		return "ok", nil
	}}
	client, _ := pair(t, ConnOptions{}, server)
	const extra = 10
	errs := make(chan error, MaxInflight+extra)
	for range MaxInflight + extra {
		go func() { errs <- client.Call(context.Background(), "slow", nil, nil) }()
	}
	for range extra {
		select {
		case err := <-errs:
			if ErrorCode(err) != CodeRateLimited {
				t.Fatalf("over the limit: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("requests over the limit were not refused")
		}
	}
	close(release)
	for range MaxInflight {
		if err := <-errs; err != nil {
			t.Fatalf("under the limit: %v", err)
		}
	}
}

// Lines that decode only partly (a field of the wrong type) still get answers: a
// request an Invalid Request error, a pending call its failure, not a timeout.
func TestConnAnswersMalformedMessages(t *testing.T) {
	r, w := io.Pipe()
	out := &lockedBuffer{}
	c := NewConn(r, out, ConnOptions{Handle: func(context.Context, string, json.RawMessage) (any, error) { return "x", nil }})
	defer func() { _ = c.Close() }()
	_, _ = io.WriteString(w, `{"jsonrpc":2,"id":3,"method":"echo"}`+"\n")
	waitFor(t, "an answer", func() bool { return strings.Contains(string(out.Bytes()), `"id":3`) })
	if got := string(out.Bytes()); !strings.Contains(got, fmt.Sprintf(`"code":%d`, CodeInvalidRequest)) {
		t.Errorf("answer %s", got)
	}

	errc := make(chan error, 1)
	go func() { errc <- c.Call(context.Background(), "x", nil, nil) }()
	waitFor(t, "the call", func() bool { return strings.Contains(string(out.Bytes()), `"method":"x"`) })
	_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"error":{"code":"bad","message":7}}`+"\n")
	select {
	case err := <-errc:
		if ErrorCode(err) != CodeInvalidRequest || !strings.Contains(err.Error(), "malformed response") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the call waited for a malformed response")
	}
	_ = w.Close()
}

// A result over the line limit becomes an error answer instead of no answer.
func TestConnResultOverTheLineLimit(t *testing.T) {
	server := ConnOptions{MaxLine: 256, Handle: func(context.Context, string, json.RawMessage) (any, error) {
		return strings.Repeat("x", 300), nil
	}}
	client, _ := pair(t, ConnOptions{}, server)
	err := client.Call(ctxT(t), "big", nil, nil)
	if ErrorCode(err) != CodeInternal || !strings.Contains(err.Error(), "over the 256 byte line limit") {
		t.Fatalf("err = %v", err)
	}
	if err := client.Notify("n", strings.Repeat("y", MaxLine)); err == nil || !strings.Contains(err.Error(), "line limit") {
		t.Fatalf("an oversize notification: %v", err)
	}
}
