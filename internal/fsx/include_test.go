package fsx

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

func TestCleanIncludePatterns(t *testing.T) {
	long := strings.Repeat("a", MaxIncludePatternLen+1)
	many := make([]string, MaxIncludePatterns+1)
	for i := range many {
		many[i] = "f" + strings.Repeat("x", i)
	}
	tests := []struct {
		name string
		in   []string
		want []string
		err  string
	}{
		{name: "none", in: nil, want: []string{}},
		{name: "trimmed, repeats dropped", in: []string{" .env* ", "CLAUDE.local.md", ".env*"}, want: []string{".env*", "CLAUDE.local.md"}},
		{name: "folders and globs", in: []string{"docs/scratch/", "*.local.json", "build/**/*.html", "a/[bc]?.txt"},
			want: []string{"docs/scratch/", "*.local.json", "build/**/*.html", "a/[bc]?.txt"}},
		{name: "empty", in: []string{"  "}, err: "a pattern is empty"},
		{name: "negation", in: []string{"!.env"}, err: "starts with !"},
		{name: "comment", in: []string{"#x"}, err: "comment"},
		{name: "absolute", in: []string{"/etc/passwd"}, err: "relative to the project"},
		{name: "home", in: []string{"~/x"}, err: "relative to the project"},
		{name: "dot dot", in: []string{"../x"}, err: `".." segment`},
		{name: "dot dot inside", in: []string{"a/../../x"}, err: `".." segment`},
		{name: "dot", in: []string{"./x"}, err: `"." segment`},
		{name: "empty segment", in: []string{"a//b"}, err: "empty segment"},
		{name: "comma", in: []string{"a,b"}, err: "comma"},
		{name: "newline", in: []string{"a\nb"}, err: "control character"},
		{name: "bad glob", in: []string{"a[b"}, err: "valid glob"},
		{name: "too long", in: []string{long}, err: "longer than"},
		{name: "too many stars", in: []string{"**/a/**/b/**/c/**/d/**"}, err: "** segments"},
		{name: "too many", in: many, err: "at most 100"},
		{name: "repeats count once", in: slices.Repeat([]string{"x"}, MaxIncludePatterns+5), want: []string{"x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CleanIncludePatterns(tt.in)
			if tt.err != "" {
				if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.err) {
					t.Fatalf("err = %v, want %q", err, tt.err)
				}
				return
			}
			if err != nil || !slices.Equal(got, tt.want) {
				t.Fatalf("= %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestIncludeSetting(t *testing.T) {
	tests := []struct {
		v    string
		want []string
		err  bool
	}{
		{v: "", want: nil},
		{v: "none", want: nil},
		{v: " None ", want: nil},
		{v: ".env*, CLAUDE.local.md,,.env*", want: []string{".env*", "CLAUDE.local.md"}},
		{v: "docs/scratch/", want: []string{"docs/scratch/"}},
		{v: ".env*, !x", want: []string{".env*"}, err: true},
	}
	for _, tt := range tests {
		t.Run(tt.v, func(t *testing.T) {
			if got := SplitIncludeSetting(tt.v); !slices.Equal(got, tt.want) {
				t.Errorf("SplitIncludeSetting = %q, want %q", got, tt.want)
			}
			if err := CheckIncludeSetting(tt.v); (err != nil) != tt.err {
				t.Errorf("CheckIncludeSetting = %v, want error %t", err, tt.err)
			}
		})
	}
}

func TestIncludePatternMatch(t *testing.T) {
	tests := []struct {
		pattern, path string
		dir, want     bool
	}{
		{pattern: ".env*", path: ".env", want: true},
		{pattern: ".env*", path: "src/.env.local", want: true},
		{pattern: ".env*", path: "src/env", want: false},
		{pattern: "CLAUDE.local.md", path: "CLAUDE.local.md", want: true},
		{pattern: "CLAUDE.local.md", path: "pkg/CLAUDE.local.md", want: true},
		{pattern: ".claude/settings.local.json", path: ".claude/settings.local.json", want: true},
		{pattern: ".claude/settings.local.json", path: "x/.claude/settings.local.json", want: false}, // anchored
		{pattern: "docs/scratch/", path: "docs/scratch", dir: true, want: true},
		{pattern: "docs/scratch/", path: "docs/scratch", want: false}, // a file named scratch
		{pattern: "scratch/", path: "a/b/scratch", dir: true, want: true},
		{pattern: "dist", path: "dist", dir: true, want: true},
		{pattern: "dist", path: "dist", want: true},
		{pattern: "*.local.json", path: "a/b/x.local.json", want: true},
		{pattern: "a/*.go", path: "a/x.go", want: true},
		{pattern: "a/*.go", path: "a/b/x.go", want: false}, // * stops at /
		{pattern: "a/**/x.go", path: "a/x.go", want: true},
		{pattern: "a/**/x.go", path: "a/b/c/x.go", want: true},
		{pattern: "**/x.go", path: "x.go", want: true},
		{pattern: "**/x.go", path: "a/b/x.go", want: true},
		{pattern: "a/**", path: "a/b", want: true},
		{pattern: "a/**", path: "a", dir: true, want: false}, // what is inside, not the folder
		{pattern: "a/?.go", path: "a/x.go", want: true},
		{pattern: "a/[xy].go", path: "a/z.go", want: false},
		{pattern: "a/**/**/b", path: "a/b", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.pattern+" "+tt.path, func(t *testing.T) {
			ps := compileIncludes([]string{tt.pattern})
			if len(ps) != 1 {
				t.Fatalf("compiled %d patterns", len(ps))
			}
			if got := ps[0].match(tt.path, tt.dir); got != tt.want {
				t.Errorf("match = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestIncludePatternNames(t *testing.T) {
	tests := []struct {
		pattern, dir string
		want         bool
	}{
		{pattern: "build/reports/*.html", dir: "build", want: true},
		{pattern: "build/reports/*.html", dir: "build/reports", want: true},
		{pattern: "*/reports/*.html", dir: "build", want: true},
		{pattern: "build/reports/*.html", dir: "dist", want: false},
		{pattern: "build/", dir: "build", want: false}, // nothing left: that is a match, not a reach
		{pattern: ".env*", dir: "node_modules", want: false},
		{pattern: "**/.env", dir: "node_modules", want: false},
		{pattern: "a/**/x", dir: "a/b", want: false},
		{pattern: "a/**/x", dir: "a", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.pattern+" "+tt.dir, func(t *testing.T) {
			if got := compileIncludes([]string{tt.pattern})[0].names(tt.dir); got != tt.want {
				t.Errorf("names = %t, want %t", got, tt.want)
			}
		})
	}
}

func TestParseIgnored(t *testing.T) {
	got, truncated, err := parseIgnored([]string{
		"node_modules/", ".env", "logs/", "logs/a.log", "logs/b/", "logs/b/c.log", "a-b", "a/", "./x",
	})
	if err != nil || truncated {
		t.Fatal(err, truncated)
	}
	want := []IgnoredEntry{{Path: "a-b"}, {Path: "a", Dir: true}, {Path: ".env"}, {Path: "logs/a.log"}, {Path: "logs/b/c.log"}, {Path: "node_modules", Dir: true}, {Path: "x"}}
	slices.SortFunc(got, func(a, b IgnoredEntry) int { return strings.Compare(a.Path, b.Path) })
	slices.SortFunc(want, func(a, b IgnoredEntry) int { return strings.Compare(a.Path, b.Path) })
	if !slices.Equal(got, want) {
		t.Errorf("= %+v\nwant %+v", got, want)
	}
}

// ignoredRepo is a git checkout with ignored files in tracked folders, wholly ignored
// (collapsed) folders, and an untracked folder holding only ignored files.
func ignoredRepo(t *testing.T) string {
	t.Helper()
	dir := realTemp(t)
	files := map[string]string{
		".gitignore":                  "node_modules/\n.env*\n*.log\nbuild/\ndist\nCLAUDE.local.md\n.claude/settings.local.json\ndocs/scratch/\nsecret/\n",
		"README.md":                   "x",
		"src/a.go":                    "x",
		"docs/guide.md":               "x",
		".env":                        "x",
		".env.local":                  "x",
		"src/.env":                    "x",
		"node_modules/x/.env":         "x",
		"node_modules/x/i.js":         "x",
		"build/b.o":                   "x",
		"build/reports/a.html":        "x",
		"build/reports/b.txt":         "x",
		"build/reports/deep/c.html":   "x",
		"dist/sub/z.js":               "x",
		"CLAUDE.local.md":             "x",
		".claude/settings.local.json": "x",
		"docs/scratch/n.md":           "x",
		"docs/scratch/sub/m.md":       "x",
		"logs/a.log":                  "x",
		"logs/b/c.log":                "x",
		"secret/.env":                 "x",
		"secret/.git/config":          "x",
	}
	for p, s := range files {
		mkdir(t, filepath.Dir(filepath.Join(dir, p)))
		write(t, filepath.Join(dir, p), s)
	}
	if err := os.Symlink("/etc", filepath.Join(dir, "build", "link")); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q")
	git(t, dir, "add", ".gitignore", "README.md", "src/a.go", "docs/guide.md")
	git(t, dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
	return dir
}

func TestIncludedIgnored(t *testing.T) {
	dir := ignoredRepo(t)
	defaults := []string{".env*", "CLAUDE.local.md", ".claude/settings.local.json"}
	tests := []struct {
		name     string
		patterns []string
		want     []string
	}{
		{name: "no patterns", patterns: nil, want: nil},
		{name: "the defaults stay out of collapsed folders", patterns: defaults,
			want: []string{".claude/settings.local.json", ".env", ".env.local", "CLAUDE.local.md", "src/.env"}},
		{name: "a collapsed folder by path", patterns: []string{"node_modules/"}, want: []string{"node_modules/x/.env", "node_modules/x/i.js"}},
		{name: "a collapsed folder by name", patterns: []string{"node_modules"}, want: []string{"node_modules/x/.env", "node_modules/x/i.js"}},
		{name: "a nested collapsed folder", patterns: []string{"docs/scratch/"}, want: []string{"docs/scratch/n.md", "docs/scratch/sub/m.md"}},
		{name: "a nested collapsed folder by name", patterns: []string{"scratch"}, want: []string{"docs/scratch/n.md", "docs/scratch/sub/m.md"}},
		{name: "a parent folder of a collapsed one", patterns: []string{"docs/"}, want: []string{"docs/scratch/n.md", "docs/scratch/sub/m.md"}},
		{name: "a path into a collapsed folder", patterns: []string{"build/reports/*.html"}, want: []string{"build/reports/a.html"}},
		{name: "a path with ** into a collapsed folder", patterns: []string{"build/**/*.html"}, want: []string{"build/reports/a.html", "build/reports/deep/c.html"}},
		{name: "a folder inside a collapsed one", patterns: []string{"build/reports/"},
			want: []string{"build/reports/a.html", "build/reports/b.txt", "build/reports/deep/c.html"}},
		{name: "a wildcard folder into a collapsed one", patterns: []string{"*/reports/*.html"}, want: []string{"build/reports/a.html"}},
		{name: "a leading ** does not reach in", patterns: []string{"**/*.html"}, want: nil},
		{name: "a name does not reach in", patterns: []string{"*.html", "i.js"}, want: nil},
		{name: "an untracked folder git looked into", patterns: []string{"*.log"}, want: []string{"logs/a.log", "logs/b/c.log"}},
		{name: "that folder by path", patterns: []string{"logs/"}, want: []string{"logs/a.log", "logs/b/c.log"}},
		{name: "a link is listed, not followed", patterns: []string{"build/"},
			want: []string{"build/b.o", "build/link", "build/reports/a.html", "build/reports/b.txt", "build/reports/deep/c.html"}},
		{name: "a nested .git is skipped", patterns: []string{"secret/"}, want: []string{"secret/.env"}},
		{name: "a file inside a collapsed folder", patterns: []string{"dist/sub/z.js"}, want: []string{"dist/sub/z.js"}},
		{name: "a tracked file is not repeated", patterns: []string{"*.go", "README.md"}, want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, truncated, err := IncludedIgnored(context.Background(), dir, tt.patterns)
			if err != nil || truncated {
				t.Fatal(err, truncated)
			}
			slices.Sort(got)
			if !slices.Equal(got, tt.want) {
				t.Errorf("= %q\nwant %q", got, tt.want)
			}
		})
	}
}

func TestIncludedIgnoredBounds(t *testing.T) {
	dir := ignoredRepo(t)
	entries, _, err := IgnoredEntries(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	got, truncated, err := includedFrom(context.Background(), dir, entries, compileIncludes([]string{"build/"}), 2)
	if err != nil || !truncated || len(got) != 2 {
		t.Errorf("capped at 2: %q, truncated %t, %v", got, truncated, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := includedFrom(ctx, dir, entries, compileIncludes([]string{"build/"}), 10); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled: %v", err)
	}
}

func TestWithIncluded(t *testing.T) {
	got := WithIncluded([]string{"src/a.go", "README.md"}, []string{"src/.env", "build/x/y.html"})
	want := []FileEntry{
		{Path: "src", IsDir: true}, {Path: "src/a.go"}, {Path: "README.md"},
		{Path: "build", IsDir: true, Ignored: true}, {Path: "build/x", IsDir: true, Ignored: true},
		{Path: "src/.env", Ignored: true}, {Path: "build/x/y.html", Ignored: true},
	}
	if !slices.Equal(got, want) {
		t.Errorf("= %+v\nwant %+v", got, want)
	}
}

// A search lists the included ignored files, marked, and only for the patterns it was
// given.
func TestSearchIncludesIgnored(t *testing.T) {
	dir := ignoredRepo(t)
	x := NewFileIndex(nil)
	search := func(include []string, query string) []Match {
		t.Helper()
		ms, _, _, err := x.SearchSources(context.Background(), []Source{{Dir: dir, Git: true, Include: include}}, query, 50, true)
		if err != nil {
			t.Fatal(err)
		}
		return ms
	}
	if ms := search(nil, "env"); len(ms) != 0 {
		t.Errorf("without patterns: %+v", ms)
	}
	ms := search([]string{".env*"}, "env")
	var got []string
	for _, m := range ms {
		if !m.Ignored {
			t.Errorf("%s not marked ignored", m.Path)
		}
		got = append(got, m.Path)
	}
	slices.Sort(got)
	if want := []string{".env", ".env.local", "src/.env"}; !slices.Equal(got, want) {
		t.Errorf("= %q, want %q", got, want)
	}
	if ms := search([]string{".env*"}, "a.go"); len(ms) != 1 || ms[0].Ignored {
		t.Errorf("a tracked file: %+v", ms)
	}
}

// The cache keys a list by its patterns: other patterns list again, the same ones reuse
// it, and a source without git ignores them.
func TestFileIndexCacheKeysPatterns(t *testing.T) {
	x := NewFileIndex(nil)
	var mu sync.Mutex
	var calls []string
	x.list = func(_ context.Context, dir string, git bool, include []string) ([]FileEntry, bool, error) {
		mu.Lock()
		defer mu.Unlock()
		calls = append(calls, dir+" "+strings.Join(include, ","))
		return []FileEntry{{Path: "a.go"}}, false, nil
	}
	search := func(src Source) {
		t.Helper()
		if _, _, _, err := x.SearchSources(context.Background(), []Source{src}, "a", 0, false); err != nil {
			t.Fatal(err)
		}
	}
	search(Source{Dir: "/a", Git: true, Include: []string{".env*"}})
	search(Source{Dir: "/a", Git: true, Include: []string{".env*"}})
	search(Source{Dir: "/a", Git: true, Include: []string{".env*", "dist/"}})
	search(Source{Dir: "/a", Git: true})
	search(Source{Dir: "/b", Include: []string{".env*"}})
	search(Source{Dir: "/b"})
	want := []string{"/a .env*", "/a .env*,dist/", "/a ", "/b "}
	if !slices.Equal(calls, want) {
		t.Errorf("listings = %q, want %q", calls, want)
	}
}
