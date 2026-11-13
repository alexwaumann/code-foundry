package layout

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

// TestKindsJSON pins testdata/kinds.json to the identity table: the GUI's registry and its
// identity port (gui/frontend/src/shell/identity.ts) are tested against that file, so they
// cannot drift. Regenerate it with -update.
func TestKindsJSON(t *testing.T) {
	pinJSON(t, "testdata/kinds.json", Kinds())
}

// identityCase is one row of testdata/identity.json: a tab and the key Identify gives it, or
// that it refuses it. The GUI's port of the key functions runs the same rows.
type identityCase struct {
	Name    string            `json:"name"`
	Kind    string            `json:"kind"`
	Thread  string            `json:"thread,omitempty"`
	Params  map[string]string `json:"params,omitempty"`
	Key     string            `json:"key,omitempty"`
	Refused bool              `json:"refused,omitempty"`
}

// pinJSON compares v's JSON with the file, or rewrites the file with -update.
func pinJSON(t *testing.T, file string, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	got := append(pretty(b), '\n')
	if *update {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Errorf("%s is stale: run go test ./internal/layout -run 'TestKindsJSON|TestIdentify' -update\n got %s", file, got)
	}
}

func tb(kind, thread string, params ...string) *Tab {
	t := &Tab{Kind: kind, Thread: thread}
	if len(params) > 0 {
		t.Params = map[string]string{}
		for i := 0; i+1 < len(params); i += 2 {
			t.Params[params[i]] = params[i+1]
		}
	}
	return t
}

func TestIdentify(t *testing.T) {
	tests := []struct {
		name string
		tab  *Tab
		key  string
		err  error
	}{
		{"thread", tb("thread", "th-1"), "thread:th-1", nil},
		{"thread needs its thread", tb("thread", ""), "", ErrInvalidArgument},
		{"diff of a thread", tb("diff", "th-1", "project", "pj", "worktree", "w"), "diff:th-1:pj:w", nil},
		{"diff unlinked, from a Projects row", tb("diff", "", "project", "pj", "worktree", "w"), "diff::pj:w", nil},
		{"diff with a title of its own", tb("diff", "th-1", "project", "pj", "worktree", "w", "title", "Review"), "diff:th-1:pj:w:Review", nil},
		{"diff ignores what it shows", tb("diff", "th-1", "project", "pj", "worktree", "w", "path", "a.go", "base", "ref:main", "filter", "go", "fold", "1"), "diff:th-1:pj:w", nil},
		{"diff a thread framed is its own", tb("diff", "th-1", "project", "pj", "worktree", "w", "thread", "th-2", "note", "Why"), "diff:th-1:pj:w:by:th-2", nil},
		{"diff a thread framed and titled", tb("diff", "th-1", "project", "pj", "worktree", "w", "thread", "th-1", "title", "Review"), "diff:th-1:pj:w:by:th-1:Review", nil},
		{"diff needs its checkout", tb("diff", "th-1", "project", "pj"), "", ErrInvalidArgument},
		{"file by path alone", tb("file", "th-1", "path", "/r/a.go", "line", "3"), "file:/r/a.go", nil},
		{"file unlinked has the same key", tb("file", "", "path", "/r/a.go"), "file:/r/a.go", nil},
		{"file needs a path", tb("file", "th-1"), "", ErrInvalidArgument},
		{"pull request slug in lower case", tb("pullrequest", "", "slug", "Acme/App", "number", "12"), "pr:acme/app#12", nil},
		{"pull request number is a number", tb("pullrequest", "", "slug", "a/b", "number", "012"), "", ErrInvalidArgument},
		{"pull request number is positive", tb("pullrequest", "", "slug", "a/b", "number", "0"), "", ErrInvalidArgument},
		{"terminal by its terminal id", tb("terminal", "th-1", "terminal", "term-1"), "term:term-1", nil},
		{"free terminal", tb("terminal", "", "terminal", "term-1"), "term:term-1", nil},
		{"terminal needs its terminal", tb("terminal", "th-1"), "", ErrInvalidArgument},
		{"pull requests page", tb("prs", ""), "prs", nil},
		{"projects page", tb("projects", ""), "projects", nil},
		{"pages belong to no thread", tb("prs", "th-1"), "", ErrInvalidArgument},
		{"compose for a project is the space's one composer", tb("compose", "", "project", "pj"), "compose", nil},
		{"compose like a thread is the space's one composer", tb("compose", "", "like", "th-1"), "compose", nil},
		{"compose at home", tb("compose", ""), "compose", nil},
		{"mcp of a thread", tb("mcp", "th-1"), "mcp:th-1", nil},
		{"mcp needs a thread", tb("mcp", ""), "", ErrInvalidArgument},
		{"gallery by title", tb("gallery", "th-1", "title", "Shots", "images", "x"), "gallery:th-1:Shots", nil},
		{"gallery needs a title", tb("gallery", "th-1"), "", ErrInvalidArgument},
		{"ember board", tb("ember.board", "th-e"), "ember.board", nil},
		{"plugin surface by scope", tb("plugin.notes.board", "th-1", "scope", "th-1"), "plugin:notes/board/th-1", nil},
		{"plugin surface without scope", tb("plugin.notes.board", ""), "plugin:notes/board/", nil},
		{"plugin surface of a thread, no scope: one per thread", tb("plugin.notes.board", "th-1"), "plugin:notes/board/thread:th-1", nil},
		{"plugin surface of another thread", tb("plugin.notes.board", "th-2"), "plugin:notes/board/thread:th-2", nil},
		{"plugin surface of a thread naming its project scope", tb("plugin.notes.board", "th-1", "scope", "project:pj"), "plugin:notes/board/project:pj", nil},
		{"plugin kind needs plugin and surface", tb("plugin.notes", ""), "", ErrInvalidArgument},
		{"plugin kind with empty surface", tb("plugin.notes.", ""), "", ErrInvalidArgument},
		{"unknown kind", tb("files", ""), "", ErrInvalidArgument},
	}
	cases := make([]identityCase, 0, len(tests))
	for _, tt := range tests {
		cases = append(cases, identityCase{Name: tt.name, Kind: tt.tab.Kind, Thread: tt.tab.Thread, Params: tt.tab.Params, Key: tt.key, Refused: tt.err != nil})
	}
	pinJSON(t, "testdata/identity.json", cases)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, key, err := Identify(tt.tab)
			if !errors.Is(err, tt.err) || (tt.err == nil && err != nil) {
				t.Fatalf("error %v, want %v", err, tt.err)
			}
			if key != tt.key {
				t.Errorf("key %q, want %q", key, tt.key)
			}
		})
	}
}

// TestIdentityRules pins the identity rules of the specification through AddTab.
func TestIdentityRules(t *testing.T) {
	ids := &SeqIDs{}
	add := func(st *State, space string, tab *Tab) (*State, Result) {
		t.Helper()
		next, res, err := Apply(st, &AddTab{Space: space, Tab: tab}, ids)
		if err != nil {
			t.Fatal(err)
		}
		return next, res
	}
	st := NewState("sp-a", "Main")
	st, _, err := Apply(st, &NewSpace{Name: "Two"}, ids)
	if err != nil {
		t.Fatal(err)
	}
	two := st.Spaces[1].ID

	t.Run("a workspace thread has one diff per repository", func(t *testing.T) {
		s, a := add(st, "", tb("diff", "th-1", "project", "pj-1", "worktree", "w"))
		s, b := add(s, "", tb("diff", "th-1", "project", "pj-2", "worktree", "w"))
		_, c := add(s, "", tb("diff", "th-1", "project", "pj-1", "worktree", "w", "path", "x.go"))
		if a.Tab == b.Tab || c.Tab != a.Tab || !c.Existing {
			t.Errorf("tabs %s %s %s", a.Tab, b.Tab, c.Tab)
		}
	})
	t.Run("a new terminal is always a new tab", func(t *testing.T) {
		s, a := add(st, "", tb("terminal", "th-1", "terminal", "term-1"))
		_, b := add(s, "", tb("terminal", "th-1", "terminal", "term-2"))
		if a.Tab == b.Tab || b.Existing {
			t.Errorf("two terminals share tab %s", a.Tab)
		}
	})
	t.Run("pull requests and projects are one per space", func(t *testing.T) {
		s, a := add(st, "", tb("prs", ""))
		s, b := add(s, "", tb("prs", ""))
		_, c := add(s, two, tb("prs", ""))
		if a.Tab != b.Tab || !b.Existing || c.Tab == a.Tab || c.Existing {
			t.Errorf("tabs %s %s %s", a.Tab, b.Tab, c.Tab)
		}
	})
	t.Run("a pull request is one tab however its slug is spelled", func(t *testing.T) {
		s, a := add(st, "", tb("pullrequest", "", "slug", "Acme/App", "number", "3"))
		_, b := add(s, "", tb("pullrequest", "th-1", "slug", "acme/app", "number", "3"))
		if a.Tab != b.Tab {
			t.Errorf("tabs %s %s", a.Tab, b.Tab)
		}
	})
	t.Run("a thread tab is one in total", func(t *testing.T) {
		s, a := add(st, "", tb("thread", "th-1"))
		_, b := add(s, "", tb("thread", "th-1"))
		if a.Tab != b.Tab || !b.Existing {
			t.Errorf("tabs %s %s", a.Tab, b.Tab)
		}
	})
	t.Run("only a terminal takes a manual name", func(t *testing.T) {
		tab := tb("file", "", "path", "/a")
		tab.Name = "mine"
		s, a := add(st, "", tab)
		_, _, got := s.FindTab(a.Tab)
		if got.Name != "" {
			t.Errorf("file tab kept name %q", got.Name)
		}
	})
}
