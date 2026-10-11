package fsx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// gitRepo makes a git checkout with tracked, untracked, and ignored files, and the
// .claude skill and command used by the skills tests:
//
//	.gitignore              ignores build/ and *.log
//	README.md               tracked
//	src/index.ts            tracked
//	src/components/Composer.tsx  untracked (not ignored)
//	build/out.js  debug.log ignored
//	.claude/skills/x/SKILL.md  .claude/commands/y.md  tracked
func gitRepo(t *testing.T) string {
	t.Helper()
	dir := realTemp(t)
	files := map[string]string{
		".gitignore":                  "build/\n*.log\n",
		"README.md":                   "# readme\n",
		"src/index.ts":                "export {}\n",
		"src/components/Composer.tsx": "x\n",
		"build/out.js":                "x\n",
		"debug.log":                   "x\n",
		".claude/skills/x/SKILL.md":   "---\nname: x\ndescription: Does x.\n---\nbody\n",
		".claude/commands/y.md":       "# Y\n\nRuns y.\n",
	}
	for p, s := range files {
		mkdir(t, filepath.Dir(filepath.Join(dir, p)))
		write(t, filepath.Join(dir, p), s)
	}
	git(t, dir, "init", "-q")
	git(t, dir, "add", ".gitignore", "README.md", "src/index.ts", ".claude")
	git(t, dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
	return dir
}

func realTemp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func paths(es []FileEntry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.Path
		if e.IsDir {
			out[i] += "/"
		}
	}
	return out
}

func TestWithParentDirs(t *testing.T) {
	tests := []struct {
		name  string
		files []string
		want  []string
	}{
		{"none", nil, []string{}},
		{"top-level files", []string{"a", "b"}, []string{"a", "b"}},
		{"nested", []string{"a/b/c.go", "a/d.go", "e"}, []string{"a/", "a/b/", "a/b/c.go", "a/d.go", "e"}},
		{"dedup across files", []string{"x/1", "x/2", "y/z/3", "x/q/4"}, []string{"x/", "y/", "y/z/", "x/q/", "x/1", "x/2", "y/z/3", "x/q/4"}},
		{"leading ./ and empty", []string{"./a/b", "", "./c"}, []string{"a/", "a/b", "c"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := paths(WithParentDirs(tt.files))
			if !slices.Equal(got, tt.want) {
				t.Fatalf("WithParentDirs(%q) = %q, want %q", tt.files, got, tt.want)
			}
		})
	}
}

func TestGitFiles(t *testing.T) {
	dir := gitRepo(t)
	got, truncated, err := GitFiles(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("truncated")
	}
	gotPaths := paths(got)
	slices.Sort(gotPaths)
	want := []string{
		".claude/", ".claude/commands/", ".claude/commands/y.md", ".claude/skills/", ".claude/skills/x/",
		".claude/skills/x/SKILL.md", ".gitignore", "README.md", "src/", "src/components/",
		"src/components/Composer.tsx", "src/index.ts",
	}
	if !slices.Equal(gotPaths, want) {
		t.Fatalf("GitFiles = %q, want %q", gotPaths, want)
	}
}

func TestGitFilesNotARepo(t *testing.T) {
	if _, _, err := GitFiles(context.Background(), realTemp(t)); err == nil {
		t.Fatal("want an error outside a repository")
	}
}

func TestWalkFiles(t *testing.T) {
	dir := realTemp(t)
	for _, p := range []string{
		"a.txt", ".env", "src/b.go", "node_modules/x/y.js", ".git/HEAD", ".cache/z", "src/.hidden/w",
	} {
		mkdir(t, filepath.Dir(filepath.Join(dir, p)))
		write(t, filepath.Join(dir, p), "x")
	}
	symlink(t, filepath.Join(dir, "src"), filepath.Join(dir, "link"))

	tests := []struct {
		name          string
		max           int
		want          []string
		wantTruncated bool
	}{
		{"all", 0, []string{".env", "a.txt", "link", "src/", "src/b.go"}, false},
		{"capped", 2, []string{".env", "a.txt"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, truncated, err := WalkFiles(context.Background(), dir, tt.max)
			if err != nil {
				t.Fatal(err)
			}
			if g := paths(got); !slices.Equal(g, tt.want) {
				t.Fatalf("WalkFiles = %q, want %q", g, tt.want)
			}
			if truncated != tt.wantTruncated {
				t.Fatalf("truncated = %v, want %v", truncated, tt.wantTruncated)
			}
		})
	}
}

func TestFileIndexSearch(t *testing.T) {
	dir := gitRepo(t)
	plain := realTemp(t)
	for _, p := range []string{"notes/todo.md", "README.md", "node_modules/x.js"} {
		mkdir(t, filepath.Dir(filepath.Join(plain, p)))
		write(t, filepath.Join(plain, p), "x")
	}

	tests := []struct {
		name          string
		dir           string
		git           bool
		query         string
		limit         int
		want          []string
		wantTruncated bool
	}{
		{"exact basename first", dir, true, "index.ts", 0, []string{"src/index.ts"}, false},
		{"directories match", dir, true, "comp", 0, []string{"src/components/", "src/components/Composer.tsx"}, false},
		{"ignored files are not candidates", dir, true, "out", 0, nil, false},
		{"empty query: shallowest first", dir, true, "", 3, []string{".claude/", ".gitignore", "README.md"}, true},
		{"limit clamps to max", dir, true, "", 1000, nil, false},
		{"no git: walk", plain, false, "todo", 0, []string{"notes/todo.md"}, false},
		{"no git: node_modules skipped", plain, false, "x.js", 0, nil, false},
		{"git broken: falls back to the walk", plain, true, "readme", 0, []string{"README.md"}, false},
	}
	x := NewFileIndex(nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, truncated, err := x.Search(context.Background(), tt.dir, tt.git, tt.query, tt.limit)
			if err != nil {
				t.Fatal(err)
			}
			if tt.limit == 1000 { // every candidate, no more than MaxFileLimit
				if len(got) != 12 || truncated {
					t.Fatalf("got %d (truncated %v), want all 12", len(got), truncated)
				}
				return
			}
			if g := paths(got); !slices.Equal(g, tt.want) && (len(g) != 0 || len(tt.want) != 0) {
				t.Fatalf("Search(%q) = %q, want %q", tt.query, g, tt.want)
			}
			if truncated != tt.wantTruncated {
				t.Fatalf("truncated = %v, want %v", truncated, tt.wantTruncated)
			}
		})
	}
}

func TestFileIndexCache(t *testing.T) {
	dir := gitRepo(t)
	now := time.Unix(1000, 0)
	x := NewFileIndex(nil)
	x.now = func() time.Time { return now }
	search := func() []string {
		t.Helper()
		got, _, err := x.Search(context.Background(), dir, true, "new.go", 0)
		if err != nil {
			t.Fatal(err)
		}
		return paths(got)
	}
	if got := search(); len(got) != 0 {
		t.Fatalf("before: %q", got)
	}
	write(t, filepath.Join(dir, "new.go"), "package x\n")
	if got := search(); len(got) != 0 {
		t.Fatalf("within the TTL the cached list is used, got %q", got)
	}
	now = now.Add(FileCacheTTL)
	if got := search(); !slices.Equal(got, []string{"new.go"}) {
		t.Fatalf("after the TTL: %q", got)
	}
}
