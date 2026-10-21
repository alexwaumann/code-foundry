package command_test

import (
	"context"
	"errors"
	"slices"
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
	const question = `{"questions":[{"question":"Which color?","options":[{"label":"Red"},{"label":"Blue"}]}]}`
	permission := thread.Item{ID: "p-r1", Kind: thread.KindPermission, Request: &thread.Request{
		RequestID: "r1", ToolName: "Bash", Description: "touch x", InputJSON: "{\n  \"command\": \"touch x\"\n}", State: thread.RequestPending}}
	asks := thread.Item{ID: "q-r2", Kind: thread.KindQuestion, Request: &thread.Request{
		RequestID: "r2", ToolName: "AskUserQuestion", InputJSON: question, State: thread.RequestPending}}
	const allowR1 = "pending permission r1: Bash {\"command\":\"touch x\"}; answer with: code-foundry thread respond --id s1 allow (or deny --message \"why\")"
	tests := []struct {
		name  string
		start thread.Thread
		// items are the thread's items, put before the wait.
		items []thread.Item
		args  map[string]string
		// later are put one by one once the wait is under way.
		later []thread.Thread
		// remove removes the thread while the wait runs; removed before it starts.
		remove, removed bool
		// wantRemoved: the answer is the removed result (exit 1), message starting so.
		wantRemoved string
		wantMsg     string
		wantCode    connect.Code // 0: no error
		wantErr     string
		invalid     bool
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
			name: "settled at a permission prompt names it", start: working, items: []thread.Item{permission}, args: map[string]string{"id": "s1"},
			later:   []thread.Thread{with(thread.StateConnected, thread.StatusNeedsAttention, "permission: Bash touch x")},
			wantMsg: "thread s1 fix: needs attention (permission: Bash touch x)\n" + allowR1,
		},
		{
			name: "settled at a question names it", start: working, items: []thread.Item{asks}, args: map[string]string{"id": "s1", "until": "settled"},
			later: []thread.Thread{with(thread.StateConnected, thread.StatusNeedsAttention, "question: Which color?")},
			wantMsg: "thread s1 fix: needs attention (question: Which color?)\n" +
				`pending question r2: Which color? (options: Red | Blue); answer with: code-foundry thread respond --id s1 --answer "<label>"`,
		},
		{
			name: "two pending requests take --request", start: with(thread.StateConnected, thread.StatusNeedsAttention, "permission: Bash touch x"),
			items: []thread.Item{permission, asks}, args: map[string]string{"id": "s1"},
			wantMsg: "thread s1 fix: needs attention (permission: Bash touch x)\n" +
				"pending permission r1: Bash {\"command\":\"touch x\"}; answer with: code-foundry thread respond --id s1 --request r1 allow (or deny --message \"why\")\n" +
				`pending question r2: Which color? (options: Red | Blue); answer with: code-foundry thread respond --id s1 --request r2 --answer "<label>"`,
		},
		{
			name: "a stopped thread's request status counts, nothing to answer", start: with(thread.StateDisconnected, thread.StatusNeedsAttention, "permission: Bash touch x"),
			args: map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: needs attention (permission: Bash touch x), disconnected",
		},
		{
			name: "settled at an idle prompt", start: working, args: map[string]string{"id": "s1"},
			later:   []thread.Thread{with(thread.StateConnected, thread.StatusIdle, "at prompt")},
			wantMsg: "thread s1 fix: idle (at prompt)",
		},
		{
			name: "settled at an error", start: working, args: map[string]string{"id": "s1"},
			later:   []thread.Thread{with(thread.StateDisconnected, thread.StatusError, "interrupted")},
			wantMsg: "thread s1 fix: error (interrupted), disconnected",
		},
		{
			name: "settled is not starting", start: with(thread.StateStarting, thread.StatusBusy, "starting"), args: map[string]string{"id": "s1"},
			later:   []thread.Thread{with(thread.StateConnected, thread.StatusBusy, "working"), with(thread.StateConnected, thread.StatusNeedsAttention, "finished")},
			wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "a permission prompt is not idle", start: working, items: []thread.Item{permission}, args: map[string]string{"id": "s1", "until": "idle"},
			later: []thread.Thread{
				with(thread.StateConnected, thread.StatusNeedsAttention, "permission: Bash ls"),
				with(thread.StateConnected, thread.StatusBusy, "working"),
				with(thread.StateConnected, thread.StatusIdle, "at prompt"),
			},
			wantMsg: "thread s1 fix: idle (at prompt)",
		},
		{
			name: "attention", start: working, items: []thread.Item{asks}, args: map[string]string{"id": "s1", "until": "attention"},
			later: []thread.Thread{with(thread.StateConnected, thread.StatusNeedsAttention, "question: Which color?")},
			wantMsg: "thread s1 fix: needs attention (question: Which color?)\n" +
				`pending question r2: Which color? (options: Red | Blue); answer with: code-foundry thread respond --id s1 --answer "<label>"`,
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
			wantCode: connect.CodeDeadlineExceeded, wantErr: "timed out after 50ms waiting for thread s1 to settle; it is busy (working)",
		},
		{
			name: "timeout until idle", start: working, args: map[string]string{"id": "s1", "for": "50ms", "until": "idle"},
			wantCode: connect.CodeDeadlineExceeded, wantErr: "timed out after 50ms waiting for thread s1 to be idle; it is busy (working)",
		},
		{
			name: "removed while waiting", start: working, args: map[string]string{"id": "s1"}, remove: true,
			wantRemoved: "thread fix (s1) was removed at ",
		},
		{
			name: "removed before the wait", start: working, args: map[string]string{"id": "s1"}, removed: true,
			wantRemoved: "thread fix (s1) was removed at ",
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
			fake.PutItems("s1", tt.items...)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if tt.removed {
				if err := fake.Remove(ctx, "s1"); err != nil {
					t.Fatal(err)
				}
			}
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
			case tt.wantRemoved != "":
				r, ok := a.res.JSON.(command.ThreadReport)
				if !strings.HasPrefix(a.res.Message, tt.wantRemoved) || a.res.ExitCode != 1 || !ok || !r.Removed || r.Status != "removed" {
					t.Fatalf("result = %q (exit %d, JSON %#v), want %q... exit 1 removed", a.res.Message, a.res.ExitCode, a.res.JSON, tt.wantRemoved)
				}
				return
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
		!strings.Contains(err.Error(), "sent to thread s1 (#3); timed out after 50ms waiting for thread s1 to settle; it is needs attention (finished)") {
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

// thread.wait without --after counts only Claude's reaction to the thread's latest
// message (the e5 race: send, then a plain wait answered with the turn before it). See
// docs/notes/send-ordinal-wait-after.md.
func TestThreadWaitDefaultAfter(t *testing.T) {
	finished := thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "finished"}
	idle := finished
	idle.Status, idle.StatusReason = thread.StatusIdle, "at prompt"
	busy := finished
	busy.Status, busy.StatusReason = thread.StatusBusy, "working"
	answered := []thread.Item{{ID: "u-old", Kind: thread.KindUserMessage, Text: "hi"}, {ID: "t-old", Kind: thread.KindTurnEnd}}
	tests := []struct {
		name  string
		start thread.Thread
		items []thread.Item
		// send: thread.send (no --wait) before the wait.
		send bool
		args map[string]string
		// blocks: the wait returns only once a new turn ended.
		blocks  bool
		wantMsg string
	}{
		{
			name: "finished, then a send: waits for the new turn", start: finished, items: answered, send: true,
			args: map[string]string{"id": "s1"}, blocks: true, wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "idle with no new message: at once", start: idle, items: answered,
			args: map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: idle (at prompt)",
		},
		{
			name: "explicit after older than the last message: at once", start: finished,
			items: append(slices.Clone(answered), thread.Item{ID: "u-new", Kind: thread.KindUserMessage, Text: "again"}),
			args:  map[string]string{"id": "s1", "after": "u-old"}, wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "no message: at once, as before", start: finished,
			args: map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "a wake is the latest message", start: finished,
			items: append(slices.Clone(answered), thread.Item{ID: "w", Kind: thread.KindUserMessage, Origin: thread.OriginWake, Text: "[code-foundry wake] …"}),
			args:  map[string]string{"id": "s1"}, blocks: true, wantMsg: "thread s1 fix: needs attention (finished)",
		},
		{
			name: "a subagent's prompt is not the thread's message", start: finished,
			items: append(slices.Clone(answered), thread.Item{ID: "sub-u", Kind: thread.KindUserMessage, ParentToolUseID: "toolu_agent", Text: "look"}),
			args:  map[string]string{"id": "s1"}, wantMsg: "thread s1 fix: needs attention (finished)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, fake := newThreadRegistry(t)
			fake.Put(tt.start)
			fake.PutItems("s1", tt.items...)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if tt.send {
				if _, err := reg.Invoke(ctx, command.Context{}, "thread.send", map[string]string{"id": "s1", "text": "again"}); err != nil {
					t.Fatal(err)
				}
			}
			type answer struct {
				res command.Result
				err error
			}
			done := make(chan answer, 1)
			go func() {
				res, err := reg.Invoke(ctx, command.Context{}, "thread.wait", tt.args)
				done <- answer{res, err}
			}()
			if tt.blocks {
				for _, step := range []func(){
					func() { fake.Put(busy) },
					func() { fake.AppendItem("s1", thread.Item{ID: "t-new", Kind: thread.KindTurnEnd}); fake.Put(finished) },
				} {
					select {
					case a := <-done:
						t.Fatalf("returned (%q, %v) before the new turn ended", a.res.Message, a.err)
					case <-time.After(30 * time.Millisecond):
					}
					step()
				}
			}
			var a answer
			select {
			case a = <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the wait did not return")
			}
			if a.err != nil || a.res.Message != tt.wantMsg {
				t.Fatalf("answer %q, %v; want %q", a.res.Message, a.err, tt.wantMsg)
			}
		})
	}
}

// A wait right after an answer does not return on the request just answered: the
// thread still reads "permission: …" until the runner publishes its new status (after
// a debounce; the fake never does), but nothing is pending any more. It returns at the
// turn's end, with no pending line. See docs/notes/thread-wait-settled.md.
func TestThreadWaitAfterAnswer(t *testing.T) {
	asking := thread.Thread{ID: "s1", Name: "fix", State: thread.StateConnected, Status: thread.StatusNeedsAttention, StatusReason: "permission: Bash touch x"}
	busy, finished := asking, asking
	busy.Status, busy.StatusReason = thread.StatusBusy, "working"
	finished.StatusReason = "finished"
	reg, fake := newThreadRegistry(t)
	fake.Put(asking)
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "touch x"},
		thread.Item{ID: "p-r1", Kind: thread.KindPermission, Request: &thread.Request{
			RequestID: "r1", ToolName: "Bash", Description: "touch x", InputJSON: `{"command":"touch x"}`, State: thread.RequestPending}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := reg.Invoke(ctx, command.Context{}, "thread.wait", map[string]string{"id": "s1"})
	if err != nil || !strings.Contains(res.Message, "\npending permission r1: Bash") {
		t.Fatalf("at the prompt: %q, %v", res.Message, err)
	}
	if _, err := fake.Respond(ctx, "s1", "r1", thread.Decision{Allow: true}); err != nil {
		t.Fatal(err)
	}
	type answer struct {
		res command.Result
		err error
	}
	done := make(chan answer, 1)
	go func() {
		res, err := reg.Invoke(ctx, command.Context{}, "thread.wait", map[string]string{"id": "s1"})
		done <- answer{res, err}
	}()
	for _, step := range []func(){
		func() { fake.Put(asking) }, // a republish of the stale status
		func() { fake.Put(busy) },
		func() { fake.AppendItem("s1", thread.Item{ID: "t1", Kind: thread.KindTurnEnd}); fake.Put(finished) },
	} {
		select {
		case a := <-done:
			t.Fatalf("returned (%q, %v) on the answered request", a.res.Message, a.err)
		case <-time.After(30 * time.Millisecond):
		}
		step()
	}
	a := <-done
	if a.err != nil || a.res.Message != "thread s1 fix: needs attention (finished)" {
		t.Fatalf("answer %q, %v", a.res.Message, a.err)
	}
}
