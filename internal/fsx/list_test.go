package fsx

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// tree builds a home directory and a sibling outside it:
//
//	home/Code/.git/           repository (registered)
//	home/code-foundry/.git    worktree (.git file)
//	home/Documents/
//	home/.config/  home/.hidden/
//	home/notes.txt            file
//	home/link-to-code ->      Code
//	home/link-to-file ->      notes.txt
//	home/escape ->            ../outside
//	home/many/d000..d204
//	outside/
func tree(t *testing.T) (home, outside string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home, outside = filepath.Join(base, "home"), filepath.Join(base, "outside")
	for _, d := range []string{"Code/.git", "code-foundry", "Documents", ".config", ".hidden", "many"} {
		mkdir(t, filepath.Join(home, d))
	}
	mkdir(t, outside)
	for i := range 205 {
		mkdir(t, filepath.Join(home, "many", fmt.Sprintf("d%03d", i)))
	}
	write(t, filepath.Join(home, "code-foundry", ".git"), "gitdir: elsewhere\n")
	write(t, filepath.Join(home, "notes.txt"), "x\n")
	symlink(t, "Code", filepath.Join(home, "link-to-code"))
	symlink(t, "notes.txt", filepath.Join(home, "link-to-file"))
	symlink(t, outside, filepath.Join(home, "escape"))
	return home, outside
}

func mkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestList(t *testing.T) {
	home, outside := tree(t)
	l := Lister{Root: home, Registered: func(p string) bool { return p == filepath.Join(home, "Code") }}
	top := []string{"Code", "code-foundry", "Documents", "escape", "link-to-code", "many"}

	tests := []struct {
		name       string
		prefix     string
		want       []string // entry names
		completion string
		truncated  bool
		wantErr    bool
	}{
		{name: "empty is home", prefix: "", want: top, completion: "~/"},
		{name: "tilde is home", prefix: "~", want: top, completion: "~/"},
		{name: "tilde slash", prefix: "~/", want: top, completion: "~/"},
		{name: "case-insensitive with common completion", prefix: "~/co", want: []string{"Code", "code-foundry"}, completion: "~/Code"},
		{name: "single match completes with slash", prefix: "~/CODE-", want: []string{"code-foundry"}, completion: "~/code-foundry/"},
		{name: "case corrected", prefix: "~/doc", want: []string{"Documents"}, completion: "~/Documents/"},
		{name: "dotdirs only for a dot segment", prefix: "~/.", want: []string{".config", ".hidden"}, completion: "~/."},
		{name: "dot prefix narrows", prefix: "~/.c", want: []string{".config"}, completion: "~/.config/"},
		{name: "absolute spelling", prefix: home + "/co", want: []string{"Code", "code-foundry"}, completion: home + "/Code"},
		{name: "root without slash lists its parent", prefix: home, wantErr: true},
		{name: "symlinked dir is listed, file symlink is not", prefix: "~/link", want: []string{"link-to-code"}, completion: "~/link-to-code/"},
		{name: "descend through symlink", prefix: "~/link-to-code/", want: nil, completion: "~/link-to-code/"},
		{name: "no match", prefix: "~/zzz", want: nil, completion: "~/zzz"},
		{name: "missing directory", prefix: "~/nope/x", want: nil, completion: "~/nope/x"},
		{name: "file as directory", prefix: "~/notes.txt/", want: nil, completion: "~/notes.txt/"},
		{name: "bounded", prefix: "~/many/", want: names("d%03d", 200), completion: "~/many/d", truncated: true},
		{name: "bounded match narrows", prefix: "~/many/d20", want: names("d2%02d", 5), completion: "~/many/d20"},
		{name: "outside via absolute", prefix: outside + "/", wantErr: true},
		{name: "filesystem root", prefix: "/", wantErr: true},
		{name: "outside via dotdot", prefix: "~/../", wantErr: true},
		{name: "outside via symlink", prefix: "~/escape/", wantErr: true},
		{name: "missing directory outside", prefix: outside + "/nope/x", wantErr: true},
		{name: "other user's home", prefix: "~bob/x", wantErr: true},
		{name: "relative", prefix: "code/x", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := l.List(tt.prefix)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("List(%q) err = %v, want ErrInvalidArgument", tt.prefix, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("List(%q): %v", tt.prefix, err)
			}
			var gotNames []string
			for _, e := range got.Entries {
				gotNames = append(gotNames, e.Name)
			}
			if !slices.Equal(gotNames, tt.want) {
				t.Errorf("names = %v, want %v", gotNames, tt.want)
			}
			if got.Completion != tt.completion {
				t.Errorf("completion = %q, want %q", got.Completion, tt.completion)
			}
			if got.Truncated != tt.truncated {
				t.Errorf("truncated = %v, want %v", got.Truncated, tt.truncated)
			}
		})
	}
}

func names(format string, n int) []string {
	out := make([]string, n)
	for i := range n {
		out[i] = fmt.Sprintf(format, i)
	}
	return out
}

func TestListFlags(t *testing.T) {
	home, _ := tree(t)
	l := Lister{Root: home, Registered: func(p string) bool { return p == filepath.Join(home, "Code") }}
	got, err := l.List("~/")
	if err != nil {
		t.Fatal(err)
	}
	type flags struct {
		path              string
		isGit, registered bool
	}
	want := map[string]flags{
		"Code":         {filepath.Join(home, "Code"), true, true},
		"code-foundry": {filepath.Join(home, "code-foundry"), true, false},
		"Documents":    {filepath.Join(home, "Documents"), false, false},
		"escape":       {filepath.Join(home, "escape"), false, false},
		// A symlink reports the flags of its target, and keeps its own path.
		"link-to-code": {filepath.Join(home, "link-to-code"), true, true},
		"many":         {filepath.Join(home, "many"), false, false},
	}
	for _, e := range got.Entries {
		w, ok := want[e.Name]
		if !ok {
			t.Errorf("unexpected entry %q", e.Name)
			continue
		}
		if g := (flags{e.Path, e.IsGit, e.Registered}); g != w {
			t.Errorf("%s = %+v, want %+v", e.Name, g, w)
		}
	}
}

func TestWithin(t *testing.T) {
	tests := []struct {
		root, path string
		want       bool
	}{
		{"/Users/me", "/Users/me", true},
		{"/Users/me", "/Users/me/code", true},
		{"/Users/me", "/users/ME/code", true},
		{"/Users/me", "/Users/meow", false},
		{"/Users/me", "/Users", false},
		{"/Users/me", "/", false},
		{"/", "/anything", true},
	}
	for _, tt := range tests {
		if got := Within(tt.root, tt.path); got != tt.want {
			t.Errorf("Within(%q, %q) = %v, want %v", tt.root, tt.path, got, tt.want)
		}
	}
}

func TestCommonFoldPrefix(t *testing.T) {
	tests := []struct {
		names []string
		want  string
	}{
		{[]string{"Code", "code-foundry"}, "Code"},
		{[]string{"abc", "abd"}, "ab"},
		{[]string{"Ärger", "ärgern"}, "Ärger"},
		{[]string{"x", "y"}, ""},
		{[]string{"only"}, "only"},
	}
	for _, tt := range tests {
		if got := commonFoldPrefix(tt.names); got != tt.want {
			t.Errorf("commonFoldPrefix(%q) = %q, want %q", tt.names, got, tt.want)
		}
	}
}
