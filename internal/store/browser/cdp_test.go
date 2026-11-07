package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// pipeConn is a conn to a stand-in for Chrome: the test writes what Chrome would say.
func pipeConn(t *testing.T, onEvent func(string, string, json.RawMessage)) (*conn, *io.PipeWriter) {
	t.Helper()
	pr, pw := io.Pipe()
	_, toChrome := io.Pipe()
	c := newConn(toChrome, pr, onEvent, nil)
	t.Cleanup(func() {
		_ = pw.Close()
		c.close()
	})
	return c, pw
}

func TestAMessagePastTheLimitIsSkippedAndTheConnectionLives(t *testing.T) {
	events := make(chan string, 4)
	c, pw := pipeConn(t, func(method, _ string, _ json.RawMessage) { events <- method })
	huge := `{"method":"Page.anything","params":{"v":"` + strings.Repeat("x", maxMessage+1<<20) + `"}}`
	go func() {
		_, _ = pw.Write(append([]byte(huge), 0))
		_, _ = pw.Write(append([]byte(`{"method":"Page.after","params":{}}`), 0))
	}()
	select {
	case m := <-events:
		if m != "Page.after" {
			t.Fatalf("event %q", m)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("nothing after the long message")
	}
	if err := c.goneErr(); err != nil {
		t.Fatalf("the connection ended: %v", err)
	}
}

func TestAReplyPastTheLimitFailsItsCallAtOnce(t *testing.T) {
	c, pw := pipeConn(t, func(string, string, json.RawMessage) {})
	done := make(chan error, 1)
	go func() { done <- c.call(context.Background(), "", "Page.getNavigationHistory", nil, nil) }()
	// The writer stands for Chrome, which never reads here: wait for the call to register.
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
		c.mu.Lock()
		n := len(c.waiting)
		c.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the call never registered")
		}
	}
	go func() {
		_, _ = fmt.Fprintf(pw, `{"id":1,"result":{"v":"%s"}}`, strings.Repeat("x", maxMessage))
		_, _ = pw.Write([]byte{0})
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errTooLong) {
			t.Fatalf("call: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the call waited for a reply that was skipped")
	}
}

func TestReadingAnEndlessMessageHoldsNoMoreThanTheLimit(t *testing.T) {
	var long bytes.Buffer
	src := io.MultiReader(strings.NewReader(`{"method":"x","params":"`), strings.NewReader(strings.Repeat("y", 3*maxMessage)), strings.NewReader("\x00{}\x00"))
	br := bufio.NewReaderSize(src, 1<<20)
	if _, err := readMessage(br, &long); !errors.Is(err, errTooLong) {
		t.Fatalf("read: %v", err)
	}
	if long.Cap() > 2*maxMessage+(1<<21) {
		t.Fatalf("held %d bytes for a limit of %d", long.Cap(), maxMessage)
	}
	if long.Len() != headBytes {
		t.Fatalf("kept %d bytes of its head", long.Len())
	}
	b, err := readMessage(br, &long)
	if err != nil || string(b) != "{}" {
		t.Fatalf("the next message: %q, %v", b, err)
	}
}
