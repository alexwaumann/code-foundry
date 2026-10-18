package thread

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// An owned thread runs in its own cwd under home, keeps its owner across a restart, and
// is left out of a filtered list unless asked for.
func TestCreateOwnedThread(t *testing.T) {
	e := newEnv(t)
	cwd := filepath.Join(e.home, "plugin-data", "hello")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	s := e.connected(CreateOptions{NoProject: true, Owner: "plugin:hello", Cwd: cwd, Name: "Assistant"})
	if s.Owner != "plugin:hello" || s.WorktreePath != cwd || s.ProjectID != "" {
		t.Fatalf("created = %+v", s)
	}
	if spec := e.spec(s.ID); !samePath(spec.Cwd, cwd) {
		t.Errorf("spawn cwd = %q, want %q", spec.Cwd, cwd)
	}
	mine := e.connected(CreateOptions{NoProject: true, Name: "mine"})
	ids := func(o ListOptions) []string {
		list, err := e.m.List(e.ctx(), o)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, th := range list {
			out = append(out, th.ID)
		}
		slices.Sort(out)
		return out
	}
	both := []string{mine.ID, s.ID}
	slices.Sort(both)
	for _, tt := range []struct {
		name string
		o    ListOptions
		want []string
	}{
		{"default: the user's only", ListOptions{}, []string{mine.ID}},
		{"all", ListOptions{All: true}, both},
		{"one plugin", ListOptions{Owner: "plugin:hello"}, []string{s.ID}},
		{"any plugin", ListOptions{Owner: "plugin:"}, []string{s.ID}},
		{"another plugin", ListOptions{Owner: "plugin:other"}, nil},
	} {
		if got := ids(tt.o); !slices.Equal(got, tt.want) {
			t.Errorf("%s: List = %v, want %v", tt.name, got, tt.want)
		}
	}
	if got := e.m.Snapshot().Owned("plugin:hello"); len(got) != 1 || got[0].ID != s.ID {
		t.Errorf("Owned = %+v", got)
	}
	e.restart()
	if got, err := e.m.Get(e.ctx(), s.ID); err != nil || got.Owner != "plugin:hello" || got.WorktreePath != cwd {
		t.Errorf("after restart = %+v (%v)", got, err)
	}
}

func TestCreateOwnedRefuses(t *testing.T) {
	e := newEnv(t)
	outside := t.TempDir()
	tests := []struct {
		name string
		o    CreateOptions
	}{
		{"bad owner", CreateOptions{NoProject: true, Owner: "Hello World"}},
		{"owner created by a thread", CreateOptions{NoProject: true, Owner: "plugin:x", CreatedBy: "s-1"}},
		{"cwd outside home", CreateOptions{NoProject: true, Cwd: outside}},
		{"cwd relative", CreateOptions{NoProject: true, Cwd: "data"}},
		{"cwd missing", CreateOptions{NoProject: true, Cwd: filepath.Join(e.home, "nope")}},
		{"cwd with a project", CreateOptions{ProjectID: "r1", Cwd: e.home}},
	}
	for _, tt := range tests {
		if _, err := e.m.Create(e.ctx(), tt.o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%s: Create = %v, want %v", tt.name, err, ErrInvalidArgument)
		}
	}
}
