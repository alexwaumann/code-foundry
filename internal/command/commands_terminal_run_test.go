package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func TestTerminalNewRun(t *testing.T) {
	const app = "/cf-test/src/app"
	repos := []*v1.Repo{{Id: "r1", Path: app, Worktrees: []*v1.Worktree{{RepoId: "r1", Path: app}}}}
	exited := connect.NewError(connect.CodeFailedPrecondition, errors.New("terminal has exited"))
	tests := []struct {
		name     string
		run      string
		noAwait  bool  // TerminalDeps.AwaitOutput is nil
		block    bool  // the shell prints nothing (Output.Block)
		awaitErr error // Output.Err
		writeErr error
		runWait  time.Duration
		callerTO time.Duration // the caller's own deadline
		wantErr  error         // errors.Is
		wantMsg  string        // substring of the error
		wantKeys string        // what Write typed; "" means no Write
		noCreate bool
		paste    bool  // the shell reads bracketed pastes
		pasteErr error // BracketedPaste fails
		noPaste  bool  // TerminalDeps.BracketedPaste is nil
	}{
		{name: "no --run types nothing"},
		{name: "a blank --run types nothing", run: " \n\t\n"},
		{name: "one line, after the prompt", run: "ls -la", wantKeys: "ls -la\r"},
		{name: "a trailing newline is the Return", run: "make test\n", wantKeys: "make test\r"},
		{name: "CRLF and trailing blank lines", run: "make test\r\n\r\n", wantKeys: "make test\r"},
		{name: "multi-line: each line is entered", run: "cd sub\nmake\n", wantKeys: "cd sub\rmake\r"},
		{name: "tabs and indentation stay", run: "for f in *; do\n\techo \"$f\"\ndone", wantKeys: "for f in *; do\r\techo \"$f\"\rdone\r"},
		{name: "a control character is refused before anything starts", run: "echo \x1b[31mred", wantErr: command.ErrInvalidArgs,
			wantMsg: "control character", noCreate: true},
		{name: "DEL is refused", run: "ls\x7f", wantErr: command.ErrInvalidArgs, noCreate: true},
		{name: "a lone CR is refused", run: "ls\rrm x", wantErr: command.ErrInvalidArgs, noCreate: true},
		{name: "no output in time: typed anyway", run: "ls", block: true, runWait: 20 * time.Millisecond, wantKeys: "ls\r"},
		{name: "the shell exits before printing", run: "ls", awaitErr: exited, wantErr: exited,
			wantMsg: "created terminal t1, but could not run the command"},
		{name: "the caller goes away while waiting", run: "ls", block: true, runWait: time.Minute,
			callerTO: 20 * time.Millisecond, wantErr: context.DeadlineExceeded, wantMsg: "could not run the command"},
		{name: "the write fails", run: "ls", writeErr: exited, wantErr: exited, wantMsg: "could not run the command", wantKeys: "ls\r"},
		{name: "without AwaitOutput it types at once", run: "ls", noAwait: true, wantKeys: "ls\r"},
		{name: "bracketed paste: one paste, then Return", run: "ls -la\n", paste: true, wantKeys: "\x1b[200~ls -la\x1b[201~\r"},
		{name: "bracketed paste keeps tabs and newlines", run: "for f in *; do\r\n\techo \"$f\"\r\ndone\n\n", paste: true,
			wantKeys: "\x1b[200~for f in *; do\n\techo \"$f\"\ndone\x1b[201~\r"},
		{name: "bracketed paste unknown: typed", run: "a\nb", paste: true, pasteErr: exited, wantKeys: "a\rb\r"},
		{name: "no BracketedPaste: typed", run: "a\nb", paste: true, noPaste: true, wantKeys: "a\rb\r"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			term := &commandtest.Terminal{WriteErr: tt.writeErr}
			out := &commandtest.Output{Block: tt.block, Err: tt.awaitErr}
			writesAtAwait := -1
			out.OnAwait = func(string) { writesAtAwait = len(writesOf(term.Requests())) }
			deps := command.TerminalDeps{Terminal: term, Repo: &commandtest.Repo{Repos: repos}, Session: &commandtest.Session{}, RunWait: tt.runWait}
			if !tt.noAwait {
				deps.AwaitOutput = out.Await
			}
			if !tt.noPaste {
				deps.BracketedPaste = func(context.Context, string) (bool, error) { return tt.paste, tt.pasteErr }
			}
			reg := command.NewRegistry()
			if err := command.RegisterTerminal(reg, deps); err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if tt.callerTO > 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, tt.callerTO)
				defer cancel()
			}
			args := map[string]string{"here": app}
			if tt.run != "" {
				args["run"] = tt.run
			}
			res, err := reg.Invoke(ctx, command.Context{}, "terminal.new", args)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) || !strings.Contains(err.Error(), tt.wantMsg) {
					t.Fatalf("err = %v, want %v containing %q", err, tt.wantErr, tt.wantMsg)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			creates := 0
			for _, r := range term.Requests() {
				if _, ok := r.(*v1.CreateTerminalRequest); ok {
					creates++
				}
			}
			if want := map[bool]int{true: 0, false: 1}[tt.noCreate]; creates != want {
				t.Errorf("creates = %d, want %d", creates, want)
			}
			writes := writesOf(term.Requests())
			switch {
			case tt.wantKeys == "" && len(writes) != 0:
				t.Errorf("writes = %v, want none", writes)
			case tt.wantKeys != "":
				if len(writes) != 1 {
					t.Fatalf("writes = %v, want one", writes)
				}
				if w := writes[0]; w.GetId() != "t1" || string(w.GetData()) != tt.wantKeys {
					t.Errorf("Write = %s %q, want t1 %q", w.GetId(), w.GetData(), tt.wantKeys)
				}
			}
			awaited := out.IDs()
			wantAwait := strings.TrimSpace(tt.run) != "" && !tt.noAwait && !tt.noCreate
			if wantAwait != (len(awaited) == 1) || (wantAwait && (awaited[0] != "t1" || writesAtAwait != 0)) {
				t.Errorf("awaited %v with %d writes done, want await %v before any write", awaited, writesAtAwait, wantAwait)
			}
			if err == nil {
				want := "created terminal t1"
				if tt.wantKeys != "" {
					want += " and ran the command in it"
				}
				if res.Message != want {
					t.Errorf("message = %q, want %q", res.Message, want)
				}
			}
		})
	}
}

func writesOf(reqs []proto.Message) []*v1.WriteTerminalRequest {
	var out []*v1.WriteTerminalRequest
	for _, r := range reqs {
		if w, ok := r.(*v1.WriteTerminalRequest); ok {
			out = append(out, w)
		}
	}
	return out
}
