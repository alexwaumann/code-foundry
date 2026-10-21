package claudestream

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

// A CLI that stops reading stdin fails a write at its deadline (ErrStalled) instead of
// holding the writer forever. Half a line written closes stdin (later writes are
// ErrClosed); a write that wrote nothing leaves it open.
func TestConnStalledWrite(t *testing.T) {
	tests := []struct {
		name string
		// full fills the pipe first, so the write writes nothing.
		full      bool
		wantAfter error
	}{
		{name: "half a line written", wantAfter: ErrClosed},
		{name: "nothing written", full: true, wantAfter: ErrStalled},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = r.Close(); _ = w.Close() })
			if tt.full {
				_ = w.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
				for {
					if _, err := w.Write(make([]byte, 4096)); err != nil {
						break
					}
				}
				_ = w.SetWriteDeadline(time.Time{})
			}
			outR, outW := io.Pipe()
			c := NewConn(outR, w, Options{})
			t.Cleanup(func() { _ = outW.Close(); c.Close() })
			send := func(text string) error {
				ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
				defer cancel()
				return c.Send(ctx, UserMessage{Blocks: []ContentBlock{TextBlock(text)}})
			}
			start := time.Now()
			if err := send(strings.Repeat("y", 1<<20)); !errors.Is(err, ErrStalled) {
				t.Fatalf("send: %v, want ErrStalled", err)
			}
			if took := time.Since(start); took > 3*time.Second {
				t.Errorf("the stalled send took %s", took)
			}
			if err := send("next"); !errors.Is(err, tt.wantAfter) {
				t.Errorf("the next send: %v, want %v", err, tt.wantAfter)
			}
		})
	}
}

// CloseStdin does not wait behind a write the CLI does not read: it ends it.
func TestConnCloseStdinEndsABlockedWrite(t *testing.T) {
	inR, inW := io.Pipe() // no deadlines: the write blocks until closed
	t.Cleanup(func() { _ = inR.Close() })
	outR, outW := io.Pipe()
	c := NewConn(outR, inW, Options{})
	t.Cleanup(func() { _ = outW.Close(); c.Close() })
	sent := make(chan error, 1)
	go func() { sent <- c.Send(context.Background(), UserMessage{Blocks: []ContentBlock{TextBlock("stuck")}}) }()
	time.Sleep(50 * time.Millisecond) // the write is under way
	closed := make(chan error, 1)
	go func() { closed <- c.CloseStdin() }()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("CloseStdin waited behind the write")
	}
	select {
	case err := <-sent:
		if !errors.Is(err, ErrClosed) {
			t.Errorf("the blocked send: %v, want ErrClosed", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the blocked send did not end")
	}
}
