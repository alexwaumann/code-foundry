package command_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

func newMemoryRegistry(t *testing.T) (*command.Registry, *memory.Store) {
	t.Helper()
	s := memory.New(filepath.Join(t.TempDir(), "memory.md"), slog.New(slog.DiscardHandler))
	r := command.NewRegistry()
	if err := command.RegisterMemory(r, s); err != nil {
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
			wantMsg:  "remembered #1: Always open PRs as drafts (applies to threads started from now on)",
			wantJSON: command.MemoryAddView{Entry: memory.Entry{Index: 1, Text: "Always open PRs as drafts"}, Added: true}},
		{name: "add another", cmd: "memory.add", args: map[string]string{"text": "Draft commit messages before committing"},
			wantMsg: "remembered #2: Draft commit messages before committing (applies to threads started from now on)"},
		{name: "add a third", cmd: "memory.add", args: map[string]string{"text": "Never open the side panel on your own"},
			wantMsg: "remembered #3"},
		{name: "duplicate is a no-op", cmd: "memory.add", args: map[string]string{"text": "always open PRs as drafts"},
			wantMsg:  "already remembered as #1: Always open PRs as drafts (nothing changed)",
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
			wantMsg:  "forgot #3: Never open the side panel on your own (applies to threads started from now on)",
			wantJSON: command.MemoryRemoveView{Removed: memory.Entry{Index: 3, Text: "Never open the side panel on your own"}}},
		{name: "remove by index", cmd: "memory.remove", args: map[string]string{"entry": "1"},
			wantMsg: "forgot #1: Always open PRs as drafts (applies to threads started from now on)"},
		{name: "clear needs confirmation", cmd: "memory.clear",
			wantErr: func(err error) bool { return errors.Is(err, command.ErrNeedsConfirmation) }, errHas: "Forget every remembered preference?"},
		{name: "clear", cmd: "memory.clear", yes: true,
			wantMsg: "forgot 1 preference (applies to threads started from now on)", wantJSON: command.MemoryClearView{Removed: 1}},
		{name: "clear empty", cmd: "memory.clear", yes: true, wantMsg: "no preferences to forget"},
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
	if err := command.RegisterMemory(r, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Invoke(context.Background(), command.Context{}, "memory.show", nil); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("show without a store = %v", err)
	}
}
