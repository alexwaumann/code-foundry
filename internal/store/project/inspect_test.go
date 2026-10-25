package project

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// mkdirs makes every dir under base; a name ending in "/.git" is a .git directory, one
// ending in ".git=" a .git file (a linked worktree's or a submodule's).
func mkdirs(t *testing.T, base string, dirs ...string) {
	t.Helper()
	for _, d := range dirs {
		if p, ok := strings.CutSuffix(d, "="); ok {
			if err := os.MkdirAll(filepath.Join(base, filepath.Dir(p)), 0o755); err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(base, p), "gitdir: /elsewhere\n")
			continue
		}
		if err := os.MkdirAll(filepath.Join(base, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func TestChildRepos(t *testing.T) {
	tests := []struct {
		name  string
		dirs  []string
		files []string // plain files under the folder
		links map[string]string
		want  []string // child names, in order
	}{
		{name: "empty folder"},
		{name: "plain children only", dirs: []string{"notes", "drafts/sub"}},
		{name: "one repo is enough", dirs: []string{"api/.git", "notes"}, want: []string{"api"}},
		{name: "a .git file counts (worktree or submodule)", dirs: []string{"wt/.git=", "web/.git"}, want: []string{"web", "wt"}},
		{name: "sorted case-insensitively", dirs: []string{"Zeta/.git", "alpha/.git", "Beta/.git"}, want: []string{"alpha", "Beta", "Zeta"}},
		{name: "two levels down does not count", dirs: []string{"group/inner/.git"}},
		{name: "hidden children are skipped", dirs: []string{".hidden/.git", "shown/.git"}, want: []string{"shown"}},
		{name: "a file named like a repo is not one", files: []string{"x.git"}, dirs: []string{"y/.git"}, want: []string{"y"}},
		{name: "symlinked children are skipped", dirs: []string{"real/.git"}, links: map[string]string{"link": "real"}, want: []string{"real"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := t.TempDir()
			mkdirs(t, base, tt.dirs...)
			for _, f := range tt.files {
				writeFile(t, filepath.Join(base, f), "x")
			}
			for name, target := range tt.links {
				if err := os.Symlink(filepath.Join(base, target), filepath.Join(base, name)); err != nil {
					t.Fatal(err)
				}
			}
			got, err := ChildRepos(base)
			if err != nil {
				t.Fatal(err)
			}
			var names []string
			for _, c := range got {
				if c.Path != filepath.Join(base, c.Name) {
					t.Errorf("child %s path = %s", c.Name, c.Path)
				}
				names = append(names, c.Name)
			}
			if !slices.Equal(names, tt.want) {
				t.Fatalf("children = %v, want %v", names, tt.want)
			}
		})
	}
	t.Run("a missing folder is an error", func(t *testing.T) {
		if _, err := ChildRepos(filepath.Join(t.TempDir(), "nope")); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("err = %v, want ErrInvalidArgument", err)
		}
	})
}

func TestInspect(t *testing.T) {
	isolateGit(t)
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "home")
	product := filepath.Join(root, "product")
	mkdirs(t, root, "product/notes", "plain/sub")
	for _, r := range []string{"product/web", "product/api", "repo"} {
		git(t, root, "init", "-q", "-b", "main", filepath.Join(root, r))
	}
	mkdirs(t, root, "repo/sub/inner/.git")
	writeFile(t, filepath.Join(product, "CLAUDE.md"), "# product\n")
	if err := os.MkdirAll(filepath.Join(base, "outside"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(product, filepath.Join(root, "product-link")); err != nil {
		t.Fatal(err)
	}
	h := startHarness(t, "", Options{AllowedRoot: root})

	tests := []struct {
		name, path string
		want       Folder
		wantErr    string
	}{
		{name: "a folder of repos", path: product, want: Folder{Path: product, ChildRepos: []ChildRepo{
			{Path: filepath.Join(product, "api"), Name: "api"}, {Path: filepath.Join(product, "web"), Name: "web"}}}},
		{name: "through a symlink, resolved", path: filepath.Join(root, "product-link"), want: Folder{Path: product, ChildRepos: []ChildRepo{
			{Path: filepath.Join(product, "api"), Name: "api"}, {Path: filepath.Join(product, "web"), Name: "web"}}}},
		{name: "a repository", path: filepath.Join(root, "repo"), want: Folder{Path: filepath.Join(root, "repo"), IsRepo: true}},
		{name: "inside a repository: no scan even with repos below", path: filepath.Join(root, "repo", "sub"),
			want: Folder{Path: filepath.Join(root, "repo", "sub"), IsRepo: true}},
		{name: "a plain folder", path: filepath.Join(root, "plain"), want: Folder{Path: filepath.Join(root, "plain")}},
		{name: "a repo child of a folder of repos is a repo", path: filepath.Join(product, "web"), want: Folder{Path: filepath.Join(product, "web"), IsRepo: true}},
		{name: "outside home", path: filepath.Join(base, "outside"), wantErr: "outside your home directory"},
		{name: "missing", path: filepath.Join(root, "nope"), wantErr: "no such file or directory"},
		{name: "empty", path: "", wantErr: "path is required"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := h.store.Inspect(context.Background(), tt.path)
			if tt.wantErr != "" {
				if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want ErrInvalidArgument containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Path != tt.want.Path || got.IsRepo != tt.want.IsRepo || !slices.Equal(got.ChildRepos, tt.want.ChildRepos) {
				t.Fatalf("Inspect = %+v, want %+v", got, tt.want)
			}
		})
	}
	if n := len(h.store.Snapshot().Projects); n != 0 {
		t.Errorf("Inspect registered %d projects", n)
	}
}
