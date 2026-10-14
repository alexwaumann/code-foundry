package terminal_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
)

func TestAwaitOutput(t *testing.T) {
	const quiet = 30 * time.Millisecond
	tests := []struct {
		name string
		// before runs before AwaitOutput; during runs concurrently with it.
		before  func(f *terminaltest.Fake, id string)
		during  func(f *terminaltest.Fake, id string)
		timeout time.Duration
		wantErr error
		minWait time.Duration
	}{
		{name: "output after the wait starts", during: func(f *terminaltest.Fake, id string) {
			time.Sleep(10 * time.Millisecond)
			_ = f.Emit(id, []byte("% "))
		}, minWait: quiet},
		{name: "output before the wait (already on screen)", before: func(f *terminaltest.Fake, id string) {
			_ = f.Emit(id, []byte("% "))
		}, minWait: quiet},
		{name: "only whitespace on screen does not count", before: func(f *terminaltest.Fake, id string) {
			_ = f.Emit(id, []byte("\r\n"))
		}, timeout: 80 * time.Millisecond, wantErr: context.DeadlineExceeded},
		{name: "more output restarts the quiet period", during: func(f *terminaltest.Fake, id string) {
			_ = f.Emit(id, []byte("loading plugins\r\n"))
			time.Sleep(quiet / 2)
			_ = f.Emit(id, []byte("still loading\r\n"))
			time.Sleep(quiet / 2)
			_ = f.Emit(id, []byte("% "))
		}, minWait: 2 * quiet},
		{name: "no output: ctx ends", timeout: 60 * time.Millisecond, wantErr: context.DeadlineExceeded},
		{name: "exits before printing", during: func(f *terminaltest.Fake, id string) {
			time.Sleep(10 * time.Millisecond)
			_ = f.Exit(id, 1)
		}, wantErr: terminal.ErrExited},
		{name: "exits after printing", during: func(f *terminaltest.Fake, id string) {
			_ = f.Emit(id, []byte("bye"))
			_ = f.Exit(id, 0)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := terminaltest.New(nil)
			term, err := f.Create(context.Background(), terminal.Spec{Argv: []string{"/bin/zsh"}})
			if err != nil {
				t.Fatal(err)
			}
			if tt.before != nil {
				tt.before(f, term.ID)
			}
			timeout := tt.timeout
			if timeout == 0 {
				timeout = 2 * time.Second
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			if tt.during != nil {
				go func() {
					// Let AwaitOutput attach first.
					for f.Attached(term.ID) == 0 {
						time.Sleep(time.Millisecond)
					}
					tt.during(f, term.ID)
				}()
			}
			start := time.Now()
			err = terminal.AwaitOutput(ctx, f, term.ID, quiet)
			if !errors.Is(err, tt.wantErr) || (tt.wantErr == nil && err != nil) {
				t.Fatalf("AwaitOutput = %v, want %v", err, tt.wantErr)
			}
			if took := time.Since(start); took < tt.minWait {
				t.Errorf("returned after %v, want at least %v", took, tt.minWait)
			}
			if n := f.Attached(term.ID); n != 0 {
				// The subscription ends with the call (the fake detaches asynchronously).
				time.Sleep(20 * time.Millisecond)
				if n := f.Attached(term.ID); n != 0 {
					t.Errorf("%d subscribers left attached", n)
				}
			}
		})
	}
	t.Run("unknown terminal", func(t *testing.T) {
		err := terminal.AwaitOutput(context.Background(), terminaltest.New(nil), "nope", quiet)
		if !errors.Is(err, terminal.ErrNotFound) {
			t.Fatalf("AwaitOutput = %v, want ErrNotFound", err)
		}
	})
}
