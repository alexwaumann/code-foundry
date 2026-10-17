package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadWait(t *testing.T) {
	working := thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"}
	with := func(st thread.State, status thread.Status, reason string) thread.Thread {
		s := working
		s.State, s.Status, s.StatusReason = st, status, reason
		return s
	}
	tests := []struct {
		name  string
		start thread.Thread
		args  map[string]string
		// later are put one by one once the wait is under way.
		later    []thread.Thread
		remove   bool
		wantMsg  string
		wantCode connect.Code // 0: no error
		wantErr  string
		invalid  bool
	}{
		{
			name: "already idle returns at once", start: with(thread.StateConnected, thread.StatusIdle, "at prompt"),
			args: map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: idle (at prompt)",
		},
		{
			name: "a stopped idle thread is idle", start: with(thread.StateDisconnected, thread.StatusIdle, "at prompt"),
			args: map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: idle (at prompt), disconnected",
		},
		{
			name: "busy until its unseen turn ends", start: working, args: map[string]string{"id": "s1"},
			later:   []thread.Thread{with(thread.StateConnected, thread.StatusNeedsAttention, "finished")},
			wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "a permission prompt is not idle", start: working, args: map[string]string{"id": "s1"},
			later: []thread.Thread{
				with(thread.StateConnected, thread.StatusNeedsAttention, "permission: Bash ls"),
				with(thread.StateConnected, thread.StatusBusy, "working"),
				with(thread.StateConnected, thread.StatusIdle, "at prompt"),
			},
			wantMsg: "thread s1 fix: idle (at prompt)",
		},
		{
			name: "attention", start: working, args: map[string]string{"id": "s1", "until": "attention"},
			later:   []thread.Thread{with(thread.StateConnected, thread.StatusNeedsAttention, "question: Which color?")},
			wantMsg: "thread s1 fix: needs attention (question: Which color?)",
		},
		{
			name: "error", start: working, args: map[string]string{"id": "s1", "until": "error"},
			later: []thread.Thread{
				with(thread.StateClosing, thread.StatusBusy, "working"),
				with(thread.StateDisconnected, thread.StatusError, "interrupted"),
			},
			wantMsg: "thread s1 fix: error (interrupted), disconnected",
		},
		{
			name: "disconnected", start: with(thread.StateConnected, thread.StatusIdle, "at prompt"), args: map[string]string{"id": "s1", "until": "disconnected"},
			later:   []thread.Thread{with(thread.StateDisconnected, thread.StatusIdle, "at prompt")},
			wantMsg: "thread s1 fix: idle (at prompt), disconnected",
		},
		{
			name: "timeout names the status", start: working, args: map[string]string{"id": "s1", "for": "50ms"},
			wantCode: connect.CodeDeadlineExceeded, wantErr: "timed out after 50ms waiting for thread s1 to be idle; it is busy (working)",
		},
		{
			name: "removed while waiting", start: working, args: map[string]string{"id": "s1"}, remove: true,
			wantCode: connect.CodeNotFound, wantErr: "thread s1 was removed",
		},
		{name: "unknown thread", start: working, args: map[string]string{"id": "s9"}, wantCode: connect.CodeNotFound, wantErr: "thread s9 not found"},
		{name: "for is not a duration", start: working, args: map[string]string{"id": "s1", "for": "soon"}, invalid: true},
		{name: "for over a day", start: working, args: map[string]string{"id": "s1", "for": "25h"}, invalid: true},
		{name: "for of zero", start: working, args: map[string]string{"id": "s1", "for": "0s"}, invalid: true},
		{name: "unknown condition", start: working, args: map[string]string{"id": "s1", "until": "done"}, invalid: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.Put(tt.start)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			type answer struct {
				res command.Result
				err error
			}
			done := make(chan answer, 1)
			go func() {
				res, err := reg.Invoke(ctx, command.Context{}, "thread.wait", tt.args)
				done <- answer{res, err}
			}()
			for _, s := range tt.later {
				// Each intermediate state must not end the wait.
				select {
				case a := <-done:
					t.Fatalf("returned early (%q, %v) before %s %q", a.res.Message, a.err, s.Status, s.StatusReason)
				case <-time.After(20 * time.Millisecond):
				}
				fake.Put(s)
			}
			if tt.remove {
				time.Sleep(20 * time.Millisecond)
				if err := fake.Remove(ctx, "s1"); err != nil {
					t.Fatal(err)
				}
			}
			a := <-done
			switch {
			case tt.invalid:
				if !errors.Is(a.err, command.ErrInvalidArgs) {
					t.Fatalf("err = %v, want invalid args", a.err)
				}
				return
			case tt.wantCode != 0:
				if connect.CodeOf(a.err) != tt.wantCode || !strings.Contains(a.err.Error(), tt.wantErr) {
					t.Fatalf("err = %v (%s), want %s containing %q", a.err, connect.CodeOf(a.err), tt.wantCode, tt.wantErr)
				}
				return
			case a.err != nil:
				t.Fatal(a.err)
			}
			if a.res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", a.res.Message, tt.wantMsg)
			}
			if s, ok := a.res.JSON.(*v1.Thread); !ok || s.GetId() != "s1" {
				t.Errorf("JSON = %#v, want the thread", a.res.JSON)
			}
		})
	}
}

// thread.send --wait and thread.wait --after wait for Claude's answer to the message,
// not for the "finished" of the turn before it (docs/notes/agents-5-cli.md).
func TestThreadWaitAfterMessage(t *testing.T) {
	finished := thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished"}
	busy := finished
	busy.Status, busy.StatusReason = thread.StatusBusy, "working"
	tests := []struct {
		name string
		cmd  string
		args map[string]string
		// subagent: a subagent's turn end first, which is no reaction of the thread's.
		subagent bool
	}{
		{name: "send --wait", cmd: "thread.send", args: map[string]string{"id": "s1", "text": "again", "wait": "true"}},
		{name: "send --wait ignores a subagent's turn", cmd: "thread.send", args: map[string]string{"id": "s1", "text": "again", "wait": "true"}, subagent: true},
		{name: "wait --after an id", cmd: "thread.wait", args: map[string]string{"id": "s1", "after": "u-new"}},
		{name: "wait --after an ordinal", cmd: "thread.wait", args: map[string]string{"id": "s1", "after": "3"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.Put(finished)
			fake.PutItems("s1", thread.Item{ID: "u-old", Kind: thread.KindUserMessage, Text: "hi"}, thread.Item{ID: "t-old", Kind: thread.KindTurnEnd})
			if tt.cmd == "thread.wait" {
				fake.AppendItem("s1", thread.Item{ID: "u-new", Kind: thread.KindUserMessage, Text: "again"})
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			type answer struct {
				res command.Result
				err error
			}
			done := make(chan answer, 1)
			go func() {
				res, err := reg.Invoke(ctx, command.Context{}, tt.cmd, tt.args)
				done <- answer{res, err}
			}()
			step := func(what string, fn func()) {
				t.Helper()
				select {
				case a := <-done:
					t.Fatalf("returned (%q, %v) before %s", a.res.Message, a.err, what)
				case <-time.After(30 * time.Millisecond):
				}
				fn()
			}
			step("the turn started", func() { fake.Put(busy) })
			if tt.subagent {
				step("a subagent's turn end", func() {
					fake.AppendItem("s1", thread.Item{ID: "t-sub", Kind: thread.KindTurnEnd, ParentToolUseID: "toolu_agent"})
					fake.Put(finished)
				})
			}
			step("the turn ended", func() {
				fake.AppendItem("s1", thread.Item{ID: "t-new", Kind: thread.KindTurnEnd})
				fake.Put(finished)
			})
			a := <-done
			if a.err != nil || a.res.Message != "thread s1 fix: needs attention (finished)" {
				t.Fatalf("answer %q, %v", a.res.Message, a.err)
			}
			if s, ok := a.res.JSON.(*v1.Thread); !ok || s.GetId() != "s1" {
				t.Errorf("JSON = %#v, want the thread", a.res.JSON)
			}
		})
	}
}

func TestThreadWaitAfterErrors(t *testing.T) {
	reg, fake := newThreadRegistry(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished"})
	fake.PutItems("s1", thread.Item{ID: "u-old", Kind: thread.KindUserMessage}, thread.Item{ID: "t-old", Kind: thread.KindTurnEnd})
	// Claude already reacted after the message: at once.
	if res, err := reg.Invoke(context.Background(), command.Context{}, "thread.wait", map[string]string{"id": "s1", "after": "u-old"}); err != nil ||
		!strings.Contains(res.Message, "finished") {
		t.Errorf("reacted already: %q, %v", res.Message, err)
	}
	_, err := reg.Invoke(context.Background(), command.Context{}, "thread.wait", map[string]string{"id": "s1", "after": "nope"})
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown item: %v", err)
	}
	_, err = reg.Invoke(context.Background(), command.Context{}, "thread.send", map[string]string{"id": "s1", "text": "x", "wait": "true", "for": "50ms"})
	if connect.CodeOf(err) != connect.CodeDeadlineExceeded ||
		!strings.Contains(err.Error(), "sent to thread s1; timed out after 50ms waiting for thread s1 to be idle; it is needs attention (finished)") {
		t.Errorf("timeout: %v", err)
	}
	_, err = reg.Invoke(context.Background(), command.Context{}, "thread.send", map[string]string{"id": "s1", "text": "x", "wait": "true", "for": "soon"})
	if !errors.Is(err, command.ErrInvalidArgs) || len(fake.Calls()) != 1 {
		t.Errorf("a bad for sends nothing: %v, calls %v", err, fake.Calls())
	}
}

// A wait the caller gives up on (Ctrl-C in the CLI) ends without waiting for its timeout.
func TestThreadWaitCancelled(t *testing.T) {
	reg, fake := newThreadRegistry(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected, Status: thread.StatusBusy, StatusReason: "working"})
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	_, err := reg.Invoke(ctx, command.Context{}, "thread.wait", map[string]string{"id": "s1"})
	if connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("err = %v, want canceled", err)
	}
}
