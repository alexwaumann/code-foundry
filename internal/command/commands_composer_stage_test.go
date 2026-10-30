package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestComposerStage(t *testing.T) {
	inThread := command.Context{ActiveThreadID: "s1", CallerThreadID: "s1"}
	tests := []struct {
		name      string
		ctx       command.Context
		args      map[string]string
		windows   int
		viewed    map[string]bool
		threadErr error
		wantMsg   string
		wantErr   string // substring; wantInvalid says whether it is an invalid arg
		invalid   bool
		// wantThread and wantText are the StageComposer sent; "" for none.
		wantThread, wantText string
	}{
		{name: "from a page in a thread a window shows", ctx: inThread, args: map[string]string{"text": "Add my first project"},
			windows: 2, viewed: map[string]bool{"s1": true},
			wantMsg: "windows=2 thread=s1", wantThread: "s1", wantText: "Add my first project"},
		{name: "--thread names another thread", ctx: inThread, args: map[string]string{"text": "hi", "thread": "s2"},
			windows: 1, viewed: map[string]bool{"s2": true}, wantMsg: "windows=1 thread=s2", wantThread: "s2", wantText: "hi"},
		{name: "keeps the text as given", ctx: inThread, args: map[string]string{"text": "  line one\nline two  "},
			windows: 1, viewed: map[string]bool{"s1": true}, wantThread: "s1", wantText: "  line one\nline two  "},
		{name: "no window shows the thread", ctx: inThread, args: map[string]string{"text": "hi"},
			windows: 1, viewed: map[string]bool{"s2": true}, wantMsg: "no app window shows thread s1: nothing was staged"},
		{name: "no window open", ctx: inThread, args: map[string]string{"text": "hi"},
			wantMsg: "no app window shows thread s1: nothing was staged"},
		{name: "from the app: no message", ctx: command.Context{ActiveThreadID: "s1", ActiveView: "thread"}, args: map[string]string{"text": "hi"},
			windows: 1, viewed: map[string]bool{"s1": true}, wantThread: "s1", wantText: "hi"},
		{name: "outside a thread without --thread", args: map[string]string{"text": "hi"}, windows: 1,
			wantErr: "needs a thread", invalid: true},
		{name: "blank text", ctx: inThread, args: map[string]string{"text": " \n"}, windows: 1,
			wantErr: "is empty", invalid: true},
		{name: "missing text", ctx: inThread, windows: 1, wantErr: `missing required argument "text"`, invalid: true},
		{name: "unknown thread", ctx: inThread, args: map[string]string{"text": "hi"}, windows: 1,
			threadErr: connect.NewError(connect.CodeNotFound, errors.New("thread s1 not found")), wantErr: "not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			emit := &commandtest.Emitter{Delivered: tt.windows, OpenWindows: tt.windows}
			reg := command.NewRegistry()
			deps := command.ViewDeps{Emitter: emit, Thread: &commandtest.Thread{Err: tt.threadErr}, Viewed: func(id string) bool { return tt.viewed[id] }}
			if err := command.RegisterView(reg, deps); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "composer.stage", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) || errors.Is(err, command.ErrInvalidArgs) != tt.invalid {
					t.Fatalf("err = %v, want %q (invalid arg %v)", err, tt.wantErr, tt.invalid)
				}
				if n := len(emit.Intents()); n != 0 {
					t.Fatalf("emitted %d intents for a refused call", n)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.wantMsg != "" || tt.ctx.ActiveView != "" {
				if res.Message != tt.wantMsg {
					t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
				}
			}
			got := emit.Intents()
			if tt.wantThread == "" {
				if len(got) != 0 {
					t.Fatalf("intents = %v, want none", got)
				}
				if js, ok := res.JSON.(command.ComposerStageResult); !ok || js.Staged {
					t.Errorf("json = %#v, want not staged", res.JSON)
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("intents = %v, want one StageComposer", got)
			}
			s := got[0].GetStageComposer()
			if s.GetThreadId() != tt.wantThread || s.GetText() != tt.wantText {
				t.Errorf("StageComposer = %v, want thread %q text %q", s, tt.wantThread, tt.wantText)
			}
			if js, ok := res.JSON.(command.ComposerStageResult); !ok || !js.Staged || js.Thread != tt.wantThread {
				t.Errorf("json = %#v, want staged in %s", res.JSON, tt.wantThread)
			}
		})
	}
}
