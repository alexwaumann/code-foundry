package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// sentenceCase reports whether label is in sentence case: its first letter upper case,
// every later word's first letter lower case ("Clean up", "Close pull request").
func sentenceCase(label string) bool {
	words := strings.Fields(label)
	if len(words) == 0 {
		return false
	}
	for i, w := range words {
		r, _ := utf8.DecodeRuneInString(w)
		if (i == 0) != unicode.IsUpper(r) {
			return false
		}
	}
	return true
}

func TestSentenceCase(t *testing.T) {
	tests := []struct {
		label string
		want  bool
	}{
		{"Remove", true},
		{"Clean up", true},
		{"Close pull request", true},
		{"Turn On", false},
		{"remove", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := sentenceCase(tt.label); got != tt.want {
			t.Errorf("sentenceCase(%q) = %v, want %v", tt.label, got, tt.want)
		}
	}
}

// Every built-in command that asks names its confirm button: without ConfirmLabel the
// GUI's button says the title ("Archive or Unarchive Thread"). The label is in sentence
// case; Title stays in title case for the palette and the Help menu.
func TestConfirmingCommandsHaveLabels(t *testing.T) {
	f := newFixture(t)
	asked := 0
	for _, l := range f.reg.List(command.Context{}, true) {
		c, ok := f.reg.Get(l.Name)
		if !ok || c.Confirm == "" {
			continue
		}
		asked++
		switch {
		case c.ConfirmLabel == "":
			t.Errorf("%s asks %q with no ConfirmLabel", c.Name, c.Confirm)
		case !sentenceCase(c.ConfirmLabel):
			t.Errorf("%s ConfirmLabel %q is not in sentence case", c.Name, c.ConfirmLabel)
		}
	}
	if asked == 0 {
		t.Fatal("no command with Confirm: the fixture registered nothing that asks")
	}
}

func TestRegisterRefusesDynamicConfirmLabelWithoutConfirmLabel(t *testing.T) {
	err := command.NewRegistry().Register(command.Command{
		Name: "x.y", Title: "X", Category: "X", Confirm: "Go?",
		DynamicConfirmLabel: func(context.Context, command.Context, command.Args) string { return "Go" },
		Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
			return command.Result{}, nil
		},
	})
	if err == nil {
		t.Fatal("registered DynamicConfirmLabel without ConfirmLabel")
	}
}

// askOf invokes name unconfirmed and returns the question it asks.
func askOf(t *testing.T, reg *command.Registry, uctx command.Context, name string, args map[string]string) *command.ConfirmError {
	t.Helper()
	_, err := reg.Invoke(context.Background(), uctx, name, args)
	var ce *command.ConfirmError
	if !errors.As(err, &ce) {
		t.Fatalf("%s: err = %v, want a confirmation", name, err)
	}
	return ce
}

// terminal.kill names the terminal by what a user sees of it, else its id.
func TestTerminalKillConfirmNamesTheTerminal(t *testing.T) {
	tests := []struct {
		name     string
		terminal *v1.Terminal
		want     string
	}{
		{name: "a plugin's title", terminal: &v1.Terminal{Id: "t9", Foreground: "node x.js", Labels: map[string]string{termlabel.Title: "Dev server"}},
			want: "Kill terminal “Dev server”? Its process is terminated."},
		{name: "an action's name", terminal: &v1.Terminal{Id: "t9", Labels: map[string]string{termlabel.ActionName: "Test"}},
			want: "Kill terminal “Test”? Its process is terminated."},
		{name: "the running job", terminal: &v1.Terminal{Id: "t9", Foreground: "npm run dev"},
			want: "Kill terminal “npm run dev”? Its process is terminated."},
		{name: "idle: the id", terminal: &v1.Terminal{Id: "t9", Foreground: "  "},
			want: "Kill terminal t9? Its process is terminated."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			f.term.Terminals = []*v1.Terminal{tt.terminal}
			ce := askOf(t, f.reg, command.Context{}, "terminal.kill", map[string]string{"id": "t9"})
			if ce.Message != tt.want || ce.Label != "Kill" {
				t.Errorf("asked %q (%q), want %q (Kill)", ce.Message, ce.Label, tt.want)
			}
		})
	}
}

// The project commands that ask name the project, not the id the GUI passes; an id with
// no project stays an id.
func TestProjectConfirmsNameTheProject(t *testing.T) {
	const unregister = " from Code Foundry? Nothing else on disk is deleted: only clean worktrees Code Foundry made that no thread uses (branches stay). Its threads lose their worktree."
	tests := []struct {
		name      string
		cmd       string
		args      map[string]string
		want      string
		wantLabel string
	}{
		{name: "unregister by id", cmd: "project.unregister", args: map[string]string{"project": "r1"},
			want: "Remove project app" + unregister, wantLabel: "Remove"},
		{name: "unregister by name", cmd: "project.unregister", args: map[string]string{"project": "app"},
			want: "Remove project app" + unregister, wantLabel: "Remove"},
		{name: "unregister an unknown project", cmd: "project.unregister", args: map[string]string{"project": "r9"},
			want: "Remove project r9" + unregister, wantLabel: "Remove"},
		{name: "delete", cmd: "project.delete", args: map[string]string{"project": "r1"},
			want: "Delete project app and its folder on disk? This cannot be undone.", wantLabel: "Delete"},
		{name: "cleanup without a dry run's list", cmd: "project.worktree.cleanup", args: map[string]string{"project": "r1"},
			want:      "Fetch app and remove the worktrees Code Foundry made whose work is already in the default branch? Branches are kept.",
			wantLabel: "Clean up"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &commandtest.Project{
				Projects: []*v1.Project{{Id: "r1", Name: "app", Git: true}},
				OnCleanup: func(*v1.CleanupWorktreesRequest) (*v1.CleanupWorktreesResponse, error) {
					return nil, connect.NewError(connect.CodeUnavailable, errors.New("down"))
				},
			}
			reg := command.NewRegistry()
			if err := command.RegisterProject(reg, p, nil); err != nil {
				t.Fatal(err)
			}
			if err := command.RegisterNewProjects(reg, command.NewProjectDeps{
				Backend: &commandtest.NewProjects{}, Deletable: func(command.Context) bool { return true },
			}); err != nil {
				t.Fatal(err)
			}
			if err := command.RegisterProjectCleanup(reg, command.ProjectCleanupDeps{Project: p}); err != nil {
				t.Fatal(err)
			}
			ce := askOf(t, reg, command.Context{}, tt.cmd, tt.args)
			if ce.Message != tt.want || ce.Label != tt.wantLabel {
				t.Errorf("asked %q (%q), want %q (%q)", ce.Message, ce.Label, tt.want, tt.wantLabel)
			}
		})
	}
}

// thread.archive's button says Archive, not the command's title.
func TestThreadArchiveConfirmLabel(t *testing.T) {
	busy := &v1.Thread{Id: "s-aaaa11112222", Name: "Fix login", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	reg, _ := newBulkRegistry(t, busy)
	ce := askOf(t, reg, command.Context{}, "thread.archive", map[string]string{"id": busy.Id})
	if want := "Archive thread Fix login? Claude is still working; archiving ends the turn."; ce.Message != want || ce.Label != "Archive" {
		t.Errorf("asked %q (%q), want %q (Archive)", ce.Message, ce.Label, want)
	}
}

// app.restart's button says what it does: with an update downloaded it installs it first.
func TestAppRestartConfirmLabel(t *testing.T) {
	tests := []struct {
		name  string
		state v1.UpdateState
		want  string
	}{
		{name: "nothing downloaded", state: v1.UpdateState_UPDATE_STATE_IDLE, want: "Restart"},
		{name: "an update downloaded", state: v1.UpdateState_UPDATE_STATE_DOWNLOADED, want: "Install and restart"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u := &commandtest.Update{Status: &v1.UpdateStatus{State: tt.state, TargetVersion: "v0.2.0"}}
			reg := newUpdateRegistry(t, u, &commandtest.Thread{}, func() {})
			if ce := askOf(t, reg, command.Context{}, "app.restart", nil); ce.Label != tt.want {
				t.Errorf("label = %q, want %q", ce.Label, tt.want)
			}
		})
	}
}

// A removal that would delete uncommitted work asks again with a Delete button.
func TestDeleteWorkConfirmLabel(t *testing.T) {
	dirty := &v1.Worktree{Path: "/p/wt", Branch: "cf/x", Status: &v1.GitStatus{Modified: 2}}
	detail, err := connect.NewErrorDetail(&v1.UncommittedWork{Worktrees: []*v1.Worktree{dirty}})
	if err != nil {
		t.Fatal(err)
	}
	refused := connect.NewError(connect.CodeFailedPrecondition, errors.New("uncommitted work"))
	refused.AddDetail(detail)
	p := &commandtest.Project{Projects: []*v1.Project{{Id: "r1", Name: "app", Path: "/p", Git: true,
		Worktrees: []*v1.Worktree{{Path: "/p", IsMain: true}, dirty}}},
		OnRemoveWorktree: func(*v1.RemoveWorktreeRequest) error { return refused }}
	reg := command.NewRegistry()
	if err := command.RegisterProject(reg, p, nil); err != nil {
		t.Fatal(err)
	}
	_, err = reg.Invoke(context.Background(), command.Context{}, "project.worktree.remove",
		map[string]string{"project": "r1", "path": "/p/wt"}, command.Confirmed(true))
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || ce.Label != "Delete" || ce.Title != "Delete Uncommitted Work" {
		t.Fatalf("err = %#v, want the second stage labelled Delete", err)
	}
}
