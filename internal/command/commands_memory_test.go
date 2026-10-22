package command_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

func newMemoryRegistry(t *testing.T) (*command.Registry, *memory.Store) {
	t.Helper()
	s := memory.New(filepath.Join(t.TempDir(), "memory.md"), slog.New(slog.DiscardHandler))
	r := command.NewRegistry()
	if err := command.RegisterMemory(r, command.MemoryDeps{Memory: s}); err != nil {
		t.Fatal(err)
	}
	return r, s
}

func TestMemoryCommands(t *testing.T) {
	r, s := newMemoryRegistry(t)
	ctx := context.Background()
	// Steps run in order against one memory.
	for _, tt := range []struct {
		name     string
		cmd      string
		args     map[string]string
		yes      bool
		wantMsg  string
		wantErr  func(error) bool
		errHas   string
		wantJSON any
	}{
		{name: "show empty", cmd: "memory.show", wantMsg: "No preferences remembered",
			wantJSON: command.MemoryView{Entries: []memory.Entry{}}},
		{name: "add", cmd: "memory.add", args: map[string]string{"text": "  Always open PRs as drafts "},
			wantMsg:  `Remembered: "Always open PRs as drafts". New threads will follow it; threads already open get it on their next message after a restart.`,
			wantJSON: command.MemoryAddView{Entry: memory.Entry{Index: 1, Text: "Always open PRs as drafts"}, Added: true}},
		{name: "add another", cmd: "memory.add", args: map[string]string{"text": "Draft commit messages before committing"},
			wantMsg: `Remembered: "Draft commit messages before committing". New threads`},
		{name: "add a third", cmd: "memory.add", args: map[string]string{"text": "Never open the side panel on your own"},
			wantMsg: `Remembered: "Never open the side panel on your own"`},
		{name: "duplicate is a no-op", cmd: "memory.add", args: map[string]string{"text": "always open PRs as drafts"},
			wantMsg:  `Already remembered: "Always open PRs as drafts" (nothing changed).`,
			wantJSON: command.MemoryAddView{Entry: memory.Entry{Index: 1, Text: "Always open PRs as drafts"}}},
		{name: "empty", cmd: "memory.add", args: map[string]string{"text": "   "},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }, errHas: "an empty entry"},
		{name: "multi-line", cmd: "memory.add", args: map[string]string{"text": "one\ntwo"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }, errHas: "one line"},
		{name: "missing text", cmd: "memory.add",
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }},
		{name: "show", cmd: "memory.show",
			wantMsg: "1. Always open PRs as drafts\n2. Draft commit messages before committing\n3. Never open the side panel on your own",
			wantJSON: command.MemoryView{Entries: []memory.Entry{
				{Index: 1, Text: "Always open PRs as drafts"}, {Index: 2, Text: "Draft commit messages before committing"},
				{Index: 3, Text: "Never open the side panel on your own"}}}},
		{name: "ambiguous substring", cmd: "memory.remove", args: map[string]string{"entry": "draft"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) },
			errHas:  "\"draft\" is in 2 entries; give the number of one:\n  1. Always open PRs as drafts\n  2. Draft commit messages"},
		{name: "no match", cmd: "memory.remove", args: map[string]string{"entry": "rebase"},
			wantErr: func(err error) bool { return connect.CodeOf(err) == connect.CodeNotFound }, errHas: `no entry contains "rebase"`},
		{name: "index out of range", cmd: "memory.remove", args: map[string]string{"entry": "9"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }, errHas: "there is no entry 9: the entries are 1 to 3"},
		{name: "remove by unique substring", cmd: "memory.remove", args: map[string]string{"entry": "side panel"},
			wantMsg:  `Forgot: "Never open the side panel on your own".`,
			wantJSON: command.MemoryRemoveView{Removed: memory.Entry{Index: 3, Text: "Never open the side panel on your own"}}},
		{name: "remove by index", cmd: "memory.remove", args: map[string]string{"entry": "1"},
			wantMsg: `Forgot: "Always open PRs as drafts".`},
		{name: "clear needs confirmation", cmd: "memory.clear",
			wantErr: func(err error) bool { return errors.Is(err, command.ErrNeedsConfirmation) }, errHas: "Forget every remembered preference?"},
		{name: "clear", cmd: "memory.clear", yes: true,
			wantMsg: "Forgot 1 preference.", wantJSON: command.MemoryClearView{Removed: 1}},
		{name: "clear empty", cmd: "memory.clear", yes: true, wantMsg: "No preferences to forget."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			res, err := r.Invoke(ctx, command.Context{}, tt.cmd, tt.args, command.Confirmed(tt.yes))
			if tt.wantErr != nil {
				if err == nil || !tt.wantErr(err) {
					t.Fatalf("err = %v (%T)", err, err)
				}
				if !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %q, want containing %q", err, tt.errHas)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want containing %q", res.Message, tt.wantMsg)
			}
			if tt.wantJSON != nil && fmt.Sprintf("%#v", res.JSON) != fmt.Sprintf("%#v", tt.wantJSON) {
				t.Errorf("JSON = %#v, want %#v", res.JSON, tt.wantJSON)
			}
		})
	}
	if _, err := os.Stat(s.Path()); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("memory file after clear: %v", err)
	}
}

// The caps refuse with FailedPrecondition and name the cap.
func TestMemoryAddCap(t *testing.T) {
	r, _ := newMemoryRegistry(t)
	for i := range memory.MaxEntries {
		if _, err := r.Invoke(context.Background(), command.Context{}, "memory.add", map[string]string{"text": fmt.Sprintf("preference %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	_, err := r.Invoke(context.Background(), command.Context{}, "memory.add", map[string]string{"text": "one too many"})
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "at most 40 entries") {
		t.Errorf("41st add = %v", err)
	}
}

func TestMemoryCommandsWithoutStore(t *testing.T) {
	r := command.NewRegistry()
	if err := command.RegisterMemory(r, command.MemoryDeps{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Invoke(context.Background(), command.Context{}, "memory.show", nil); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("show without a store = %v", err)
	}
}

// memoryThreads is a fake MemoryThreads: the threads by id, else err (NotFound when nil).
type memoryThreads struct {
	threads map[string]*v1.Thread
	err     error
}

func (f memoryThreads) Get(_ context.Context, req *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error) {
	if s, ok := f.threads[req.Msg.GetId()]; ok {
		return connect.NewResponse(&v1.GetThreadResponse{Thread: s}), nil
	}
	if f.err != nil {
		return nil, f.err
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s not found", req.Msg.GetId()))
}

// A change from a thread another thread started is refused; one from the user's own
// thread goes through, is logged with the thread's id and shown in every window; the
// GUI and the user's own terminal change it silently.
func TestMemoryCaller(t *testing.T) {
	threads := map[string]*v1.Thread{
		"s-user":  {Id: "s-user", Name: "Fix login"},
		"s-child": {Id: "s-child", Name: "worker", CreatedBy: "s-user"},
		"s-plain": {Id: "s-plain"},
	}
	cli := func(id string) command.Context { return command.Context{ActiveThreadID: id} }
	for _, tt := range []struct {
		name      string
		lookupErr error
		uctx      command.Context
		cmd       string
		args      map[string]string
		wantCode  connect.Code
		errHas    string
		wantLog   string // in the memory store's log
		wantTitle string // the notification's; "" for none
		wantBody  string
		wantLeft  []string
	}{
		{name: "the user's thread adds", uctx: cli("s-user"), cmd: "memory.add", args: map[string]string{"text": "Use tabs"},
			wantLog: "by=s-user", wantTitle: "Remembered: Use tabs", wantBody: `By thread "Fix login".`, wantLeft: []string{"Keep it short", "Use tabs"}},
		{name: "an unnamed thread is named by id", uctx: cli("s-plain"), cmd: "memory.remove", args: map[string]string{"entry": "1"},
			wantLog: "by=s-plain", wantTitle: "Forgot: Keep it short", wantBody: `By thread "s-plain".`, wantLeft: nil},
		{name: "a duplicate shows nothing", uctx: cli("s-user"), cmd: "memory.add", args: map[string]string{"text": "keep it short."},
			wantLeft: []string{"Keep it short"}},
		{name: "a child thread cannot add", uctx: cli("s-child"), cmd: "memory.add", args: map[string]string{"text": "Use tabs"},
			wantCode: connect.CodePermissionDenied, errHas: "memory is written from the user's own threads only: thread s-child was started by thread s-user",
			wantLeft: []string{"Keep it short"}},
		{name: "a child thread cannot remove", uctx: cli("s-child"), cmd: "memory.remove", args: map[string]string{"entry": "1"},
			wantCode: connect.CodePermissionDenied, errHas: "the user's own threads only", wantLeft: []string{"Keep it short"}},
		{name: "a child thread cannot clear", uctx: cli("s-child"), cmd: "memory.clear",
			wantCode: connect.CodePermissionDenied, errHas: "the user's own threads only", wantLeft: []string{"Keep it short"}},
		{name: "a child thread can read", uctx: cli("s-child"), cmd: "memory.show", wantLeft: []string{"Keep it short"}},
		{name: "a thread gone from the store counts as the user's", uctx: cli("s-gone"), cmd: "memory.add", args: map[string]string{"text": "Use tabs"},
			wantLog: "by=s-gone", wantTitle: "Remembered: Use tabs", wantBody: `By thread "s-gone".`, wantLeft: []string{"Keep it short", "Use tabs"}},
		{name: "a failed lookup changes nothing", lookupErr: errors.New("database is locked"), uctx: cli("s-other"), cmd: "memory.add",
			args: map[string]string{"text": "Use tabs"}, wantCode: connect.CodeUnknown, errHas: "look up the calling thread s-other", wantLeft: []string{"Keep it short"}},
		{name: "the user's terminal", cmd: "memory.add", args: map[string]string{"text": "Use tabs"},
			wantLog: "by=\"\"", wantLeft: []string{"Keep it short", "Use tabs"}},
		{name: "the GUI viewing a child thread", uctx: command.Context{ActiveThreadID: "s-child", ActiveView: "thread"}, cmd: "memory.clear",
			wantLog: "by=\"\"", wantLeft: nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var logs bytes.Buffer
			s := memory.New(filepath.Join(t.TempDir(), "memory.md"), slog.New(slog.NewTextHandler(&logs, nil)))
			if _, err := s.Add("Keep it short", ""); err != nil {
				t.Fatal(err)
			}
			logs.Reset()
			em := &commandtest.Emitter{}
			r := command.NewRegistry()
			if err := command.RegisterMemory(r, command.MemoryDeps{Memory: s, Threads: memoryThreads{threads, tt.lookupErr}, Emitter: em}); err != nil {
				t.Fatal(err)
			}
			_, err := r.Invoke(context.Background(), tt.uctx, tt.cmd, tt.args, command.Confirmed(true))
			switch {
			case tt.errHas != "":
				if err == nil || connect.CodeOf(err) != tt.wantCode || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v (%v), want %v containing %q", err, connect.CodeOf(err), tt.wantCode, tt.errHas)
				}
			case err != nil:
				t.Fatal(err)
			}
			if tt.wantLog != "" && !strings.Contains(logs.String(), tt.wantLog) {
				t.Errorf("log = %q, want %q", logs.String(), tt.wantLog)
			}
			intents := em.Intents()
			switch {
			case tt.wantTitle == "" && len(intents) > 0:
				t.Errorf("notified %v", intents)
			case tt.wantTitle != "":
				if len(intents) != 1 || intents[0].GetNotify().GetTitle() != tt.wantTitle || intents[0].GetNotify().GetBody() != tt.wantBody {
					t.Errorf("intents = %v, want %q / %q", intents, tt.wantTitle, tt.wantBody)
				}
			}
			if left, err := s.Texts(); err != nil || !slices.Equal(left, tt.wantLeft) {
				t.Errorf("memory = %q, %v; want %q", left, err, tt.wantLeft)
			}
		})
	}
}

// Several words given as positionals are one entry: `memory add use tabs` needs no
// quotes (ArgSpec.Rest).
func TestMemoryArgsTakeTheRest(t *testing.T) {
	r, _ := newMemoryRegistry(t)
	for _, name := range []string{"memory.add", "memory.remove"} {
		c, ok := r.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if a := c.Args[len(c.Args)-1]; !a.Positional || !a.Rest {
			t.Errorf("%s's %s: positional %v, rest %v", name, a.Name, a.Positional, a.Rest)
		}
	}
}
