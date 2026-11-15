package textsearch

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/ripgrep"
	"github.com/alexwaumann/code-foundry/internal/ripgrep/ripgreptest"
)

// repo makes a git repository holding files (relative path: contents), commits what is
// not ignored, and returns its directory, symlinks resolved.
func repo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	git(t, dir, "init", "-q")
	write(t, dir, files)
	git(t, dir, "add", "-A")
	git(t, dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init", "--allow-empty")
	return dir
}

func write(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, s := range files {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = fsx.GitEnv(os.Environ())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// realSearcher runs the pinned ripgrep (ripgreptest.Real fails the test without one).
func realSearcher(t *testing.T) *Searcher {
	bin := ripgreptest.Real(t)
	return New(fsx.NewFileIndex(nil), ripgrep.NewEngine(func() (ripgrep.Binary, error) {
		return ripgrep.Binary{Path: bin, Source: ripgrep.SourceEnv}, nil
	}), nil)
}

// search runs s and returns every file sent, in order, and the summary.
func search(t *testing.T, s *Searcher, sources []fsx.Source, q Query) ([]File, Summary, error) {
	t.Helper()
	var files []File
	sum, err := s.Search(t.Context(), sources, q, func(b []File) error {
		files = append(files, b...)
		return nil
	})
	return files, sum, err
}

// rows are files as "source:path:line:text[ranges]" lines, ranges as the matched text
// between brackets, and "!" after the path for an ignored file.
func rows(files []File) []string {
	var out []string
	for _, f := range files {
		ign := ""
		if f.Ignored {
			ign = "!"
		}
		for _, l := range f.Lines {
			runes := []rune(l.Text)
			var b strings.Builder
			at := 0
			for _, r := range l.Ranges {
				b.WriteString(string(runes[at:r.Start]) + "[" + string(runes[r.Start:r.End]) + "]")
				at = r.End
			}
			b.WriteString(string(runes[at:]))
			out = append(out, fmt.Sprintf("%d:%s%s:%d:%s", f.Source, f.Path, ign, l.Number, b.String()))
		}
	}
	return out
}

func TestSearchMatching(t *testing.T) {
	dir := repo(t, map[string]string{
		"a.go":       "func Home() {}\nfunc home() {}\nhomeless := 1\n",
		"b.txt":      "a.*[b and a.b\n-v is a flag\n--regexp=x\nfunc  Home spaced\n",
		"c/d.md":     "Ünïcödé home ÜNÏ\n",
		".hidden/h":  "home in a hidden folder\n",
		".gitignore": "",
	})
	src := []fsx.Source{{Dir: dir, Git: true}}
	s := realSearcher(t)
	tests := []struct {
		name          string
		q             Query
		want          []string
		caseSensitive bool
	}{
		{
			name: "lower case ignores case", q: Query{Text: "home"},
			want: []string{
				"0:.hidden/h:1:[home] in a hidden folder",
				"0:a.go:1:func [Home]() {}", "0:a.go:2:func [home]() {}", "0:a.go:3:[home]less := 1",
				"0:b.txt:4:func  [Home] spaced",
				"0:c/d.md:1:Ünïcödé [home] ÜNÏ",
			},
		},
		{
			name: "an upper-case letter matches case", q: Query{Text: "Home"}, caseSensitive: true,
			want: []string{"0:a.go:1:func [Home]() {}", "0:b.txt:4:func  [Home] spaced"},
		},
		{
			name: "match case", q: Query{Text: "home", MatchCase: true}, caseSensitive: true,
			want: []string{"0:.hidden/h:1:[home] in a hidden folder", "0:a.go:2:func [home]() {}", "0:a.go:3:[home]less := 1", "0:c/d.md:1:Ünïcödé [home] ÜNÏ"},
		},
		{
			name: "whole word", q: Query{Text: "home", WholeWord: true},
			want: []string{"0:.hidden/h:1:[home] in a hidden folder", "0:a.go:1:func [Home]() {}", "0:a.go:2:func [home]() {}", "0:b.txt:4:func  [Home] spaced", "0:c/d.md:1:Ünïcödé [home] ÜNÏ"},
		},
		{
			name: "spaces are text", q: Query{Text: "func home"},
			want: []string{"0:a.go:1:[func Home]() {}", "0:a.go:2:[func home]() {}"},
		},
		{
			name: "two spaces are two spaces", q: Query{Text: "func  home"},
			want: []string{"0:b.txt:4:[func  Home] spaced"},
		},
		{
			name: "regex characters are literal", q: Query{Text: ".*["},
			want: []string{"0:b.txt:1:a[.*[]b and a.b"},
		},
		{
			name: "a leading dash is text, not a flag", q: Query{Text: "-v"},
			want: []string{"0:b.txt:2:[-v] is a flag"},
		},
		{
			name: "a flag-like query is text", q: Query{Text: "--regexp=x"},
			want: []string{"0:b.txt:3:[--regexp=x]"},
		},
		{
			name: "regex", q: Query{Text: `a\.b|h\w+less`, Regex: true},
			want: []string{"0:a.go:3:[homeless] := 1", "0:b.txt:1:a.*[b and [a.b]"},
		},
		{
			name: "regex smart case skips escapes", q: Query{Text: `\WHOME`, Regex: true}, caseSensitive: true,
			want: nil,
		},
		{
			name: "regex escapes alone ignore case", q: Query{Text: `\shome`, Regex: true},
			want: []string{"0:a.go:1:func[ Home]() {}", "0:a.go:2:func[ home]() {}", "0:b.txt:4:func [ Home] spaced", "0:c/d.md:1:Ünïcödé[ home] ÜNÏ"},
		},
		{
			name: "non-ascii smart case", q: Query{Text: "ünï"},
			want: []string{"0:c/d.md:1:[Ünï]cödé home [ÜNÏ]"},
		},
		{
			name: "non-ascii ranges are code points", q: Query{Text: "cödé home"},
			want: []string{"0:c/d.md:1:Ünï[cödé home] ÜNÏ"},
		},
		{name: "no match", q: Query{Text: "zzzqqq"}},
		{name: "empty query searches nothing", q: Query{Text: ""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files, sum, err := search(t, s, src, tt.q)
			if err != nil {
				t.Fatal(err)
			}
			if got := rows(files); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("rows\n got %q\nwant %q", got, tt.want)
			}
			if sum.CaseSensitive != tt.caseSensitive {
				t.Errorf("CaseSensitive = %v, want %v", sum.CaseSensitive, tt.caseSensitive)
			}
			if sum.Files != len(files) || sum.Lines != len(tt.want) || sum.Truncated() {
				t.Errorf("summary %+v for %d files, %d lines", sum, len(files), len(tt.want))
			}
		})
	}
}

func TestSearchInvalidRegex(t *testing.T) {
	dir := repo(t, map[string]string{"a": "x\n"})
	s := realSearcher(t)
	for _, tt := range []struct{ pattern, want string }{
		{"(foo", "invalid regular expression: unclosed group"},
		{"[z-a]", "invalid regular expression: invalid character class range"},
		{`foo\`, `invalid regular expression: it ends with a lone \`},
	} {
		_, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: tt.pattern, Regex: true})
		if !errors.Is(err, ErrInvalidQuery) || !strings.HasPrefix(err.Error(), tt.want) {
			t.Errorf("%q: %v, want ErrInvalidQuery %q", tt.pattern, err, tt.want)
		}
		// Literal, the same text is fine.
		if _, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: tt.pattern}); err != nil {
			t.Errorf("%q literal: %v", tt.pattern, err)
		}
	}
	if _, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "a\nb"}); !errors.Is(err, ErrInvalidQuery) {
		t.Errorf("two lines: %v, want ErrInvalidQuery", err)
	}
}

// TestSearchFileSet: text search covers exactly file search's files (fsx.FileIndex):
// git's view plus included ignored files, flagged; nothing git ignores otherwise, whatever
// ripgrep's own rules would say (.ignore, .rgignore, hidden files); the walk without git.
func TestSearchFileSet(t *testing.T) {
	dir := repo(t, map[string]string{
		".gitignore":                    ".env.local\nnode_modules/\nbuild/\n",
		"src/app.ts":                    "const key = 'needle'\n",
		".ignore":                       "src/rg-ignored.ts\n",
		".rgignore":                     "src/rgignore-ignored.ts\n",
		"src/rg-ignored.ts":             "needle in a file .ignore names\n",
		"src/rgignore-ignored.ts":       "needle in a file .rgignore names\n",
		".github/workflows/ci.yml":      "needle: hidden folder\n",
		"bin.dat":                       "",
		"build/out.js":                  "",
		"node_modules/dotenv/.env.test": "",
		"node_modules/x/index.js":       "",
		"docs/notes.md":                 "",
	})
	write(t, dir, map[string]string{
		".env.local":                    "SECRET=needle\n",
		"build/out.js":                  "needle in a build file\n",
		"node_modules/x/index.js":       "needle in node_modules\n",
		"node_modules/dotenv/.env.test": "needle in node_modules env\n",
		"untracked-later.txt":           "an untracked needle\n",
		"bin.dat":                       "needle\x00binary\n",
	})
	// A tracked symlink to a folder: listed as a file, never walked into.
	if err := os.Symlink("docs", filepath.Join(dir, "docs-link")); err != nil {
		t.Fatal(err)
	}
	write(t, dir, map[string]string{"docs/notes.md": "a needle in the docs\n"})
	s := realSearcher(t)

	files, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true, Include: []string{".env*"}}}, Query{Text: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"0:.env.local!:1:SECRET=[needle]",
		"0:.github/workflows/ci.yml:1:[needle]: hidden folder",
		"0:docs/notes.md:1:a [needle] in the docs",
		"0:src/app.ts:1:const key = '[needle]'",
		"0:src/rg-ignored.ts:1:[needle] in a file .ignore names",
		"0:src/rgignore-ignored.ts:1:[needle] in a file .rgignore names",
		"0:untracked-later.txt:1:an untracked [needle]",
	}
	if got := rows(files); !reflect.DeepEqual(got, want) {
		t.Errorf("git view\n got %q\nwant %q", got, want)
	}

	// The file search lists the same files: every path text search found is in it.
	matches, _, err := fsx.NewFileIndex(nil).SearchSources(t.Context(), []fsx.Source{{Dir: dir, Git: true, Include: []string{".env*"}}}, "", fsx.MaxFileLimit, true)
	if err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for _, m := range matches {
		listed[m.Path] = m.Ignored
	}
	for _, f := range files {
		if ign, ok := listed[f.Path]; !ok || ign != f.Ignored {
			t.Errorf("%s (ignored %v) found by text, not listed the same by file search (%v, %v)", f.Path, f.Ignored, ok, ign)
		}
	}
	for _, p := range []string{"node_modules/x/index.js", "build/out.js", "bin.dat"} {
		if _, ok := listed[p]; ok != (p == "bin.dat") {
			t.Errorf("file search lists %s: %v", p, ok)
		}
	}

	// Without the pattern, the ignored file is out.
	files, _, err = search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "SECRET"})
	if err != nil || len(files) != 0 {
		t.Errorf("SECRET without include: %q, %v", rows(files), err)
	}

	// A project without git is walked (fsx.WalkFiles): no node_modules, no dot folders.
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	write(t, plain, map[string]string{
		"a.txt": "needle\n", ".dot/b.txt": "needle\n", "node_modules/c.txt": "needle\n", ".env": "needle\n",
	})
	files, _, err = search(t, s, []fsx.Source{{Dir: plain}}, Query{Text: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := rows(files), []string{"0:.env:1:[needle]", "0:a.txt:1:[needle]"}; !reflect.DeepEqual(got, want) {
		t.Errorf("walk\n got %q\nwant %q", got, want)
	}
}

func TestSearchSourcesInOrder(t *testing.T) {
	a := repo(t, map[string]string{"z.txt": "needle a\n", "b/y.txt": "needle a2\n"})
	b := repo(t, map[string]string{"a.txt": "needle b\n"})
	s := realSearcher(t)
	files, _, err := search(t, s, []fsx.Source{{Dir: b, Git: true}, {Dir: a, Git: true}}, Query{Text: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"0:a.txt:1:[needle] b", "1:b/y.txt:1:[needle] a2", "1:z.txt:1:[needle] a"}
	if got := rows(files); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// TestSearchStableOrder: many files over several chunks, searched in parallel, come back
// in the same order every time: by path within a source.
func TestSearchStableOrder(t *testing.T) {
	files := map[string]string{}
	var want []string
	for i := range 1500 {
		p := fmt.Sprintf("d%02d/f%04d.txt", i%37, i)
		files[p] = "x\nneedle\n"
		want = append(want, p)
	}
	slices.Sort(want)
	dir := repo(t, files)
	s := realSearcher(t)
	s.limits.TotalLines = 10_000
	for range 3 {
		var got []string
		batches := 0
		sum, err := s.Search(t.Context(), []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"}, func(b []File) error {
			batches++
			for _, f := range b {
				got = append(got, f.Path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("order differs: %d paths, first %q", len(got), got[:min(5, len(got))])
		}
		if batches < 3 || sum.Files != 1500 || sum.Lines != 1500 {
			t.Errorf("%d batches, summary %+v", batches, sum)
		}
	}
}

func TestSearchLimits(t *testing.T) {
	many := strings.Repeat("needle\n", 30)
	dir := repo(t, map[string]string{
		"a.txt": many, "b.txt": many, "c.txt": "needle once\n",
		"long.txt": strings.Repeat("x", 5000) + "needle" + strings.Repeat("y", 5000) + "\n",
	})
	src := []fsx.Source{{Dir: dir, Git: true}}
	s := realSearcher(t)

	t.Run("per file and count", func(t *testing.T) {
		s.limits = Limits{FileLines: 5, CountLines: 20, TotalLines: 100, LineChars: 300, Timeout: time.Minute}
		files, sum, err := search(t, s, src, Query{Text: "needle"})
		if err != nil {
			t.Fatal(err)
		}
		if len(files) != 4 || len(files[0].Lines) != 5 || files[0].LineCount != 20 || !files[0].LineCountCapped {
			t.Fatalf("a.txt: %+v", files[0])
		}
		if c := files[2]; c.Path != "c.txt" || c.LineCount != 1 || c.LineCountCapped {
			t.Errorf("c.txt: %+v", c)
		}
		if !sum.FileCapped || sum.TotalCapped || sum.TimedOut || sum.Lines != 12 || sum.Files != 4 {
			t.Errorf("summary %+v", sum)
		}
	})
	t.Run("count exactly at the cap", func(t *testing.T) {
		s.limits = Limits{FileLines: 50, CountLines: 30, TotalLines: 100, LineChars: 300, Timeout: time.Minute}
		files, _, err := search(t, s, src, Query{Text: "needle"})
		if err != nil {
			t.Fatal(err)
		}
		if files[0].LineCount != 30 || files[0].LineCountCapped {
			t.Errorf("a.txt: count %d capped %v, want 30 not capped", files[0].LineCount, files[0].LineCountCapped)
		}
	})
	t.Run("total", func(t *testing.T) {
		s.limits = Limits{FileLines: 50, CountLines: 100, TotalLines: 35, LineChars: 300, Timeout: time.Minute}
		files, sum, err := search(t, s, src, Query{Text: "needle"})
		if err != nil {
			t.Fatal(err)
		}
		if got := len(files); got != 2 || len(files[0].Lines) != 30 || len(files[1].Lines) != 5 || files[1].LineCount != 30 {
			t.Fatalf("%d files: %q", got, rows(files))
		}
		if !sum.TotalCapped || sum.Lines != 35 || sum.Files != 2 {
			t.Errorf("summary %+v", sum)
		}
	})
	t.Run("line length", func(t *testing.T) {
		s.limits = Limits{FileLines: 50, CountLines: 100, TotalLines: 100, LineChars: 60, Timeout: time.Minute}
		files, _, err := search(t, s, src, Query{Text: "xneedley"})
		if err != nil {
			t.Fatal(err)
		}
		l := files[0].Lines[0]
		if len(l.Text) != 60 || !l.CutStart || !l.CutEnd || l.Ranges[0] != (Range{20, 28}) || l.Text[20:28] != "xneedley" {
			t.Errorf("long line: %+v", l)
		}
	})
}

func TestSearchNonUTF8AndBinary(t *testing.T) {
	dir := repo(t, map[string]string{
		"latin1.txt": "caf\xe9 needle\n",
		"bin.dat":    "needle before\n\x00\nneedle after\n",
		"late.bin":   strings.Repeat("needle\n", 10) + "\x00",
		"ok.txt":     "needle\n",
	})
	files, _, err := search(t, realSearcher(t), []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"0:latin1.txt:1:caf� [needle]", "0:ok.txt:1:[needle]"}
	if got := rows(files); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q\nwant %q", got, want)
	}
}

// slowRipgrep is a stand-in that answers --version and otherwise sleeps.
func slowRipgrep(t *testing.T) *ripgrep.Engine {
	p := filepath.Join(t.TempDir(), "rg")
	script := "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'ripgrep 15.2.0'; exit 0; fi\nexec sleep 30\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return ripgrep.NewEngine(func() (ripgrep.Binary, error) { return ripgrep.Binary{Path: p}, nil })
}

func TestSearchCancelKillsRipgrep(t *testing.T) {
	dir := repo(t, map[string]string{"a.txt": "needle\n"})
	s := New(fsx.NewFileIndex(nil), slowRipgrep(t), nil)
	var mu sync.Mutex
	var pids []int
	started := make(chan struct{}, 1)
	s.pids = func(pid int) {
		mu.Lock()
		pids = append(pids, pid)
		mu.Unlock()
		select {
		case started <- struct{}{}:
		default:
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, err := s.Search(ctx, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"}, func([]File) error { return nil })
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Search = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Search did not return after cancel")
	}
	mu.Lock()
	defer mu.Unlock()
	for _, pid := range pids {
		// Search waited for the process: it is gone, not a zombie still holding its pid.
		if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
			t.Errorf("ripgrep %d still exists after Search returned: %v", pid, err)
		}
	}
}

func TestSearchTimeout(t *testing.T) {
	dir := repo(t, map[string]string{"a.txt": "needle\n"})
	s := New(fsx.NewFileIndex(nil), slowRipgrep(t), nil)
	s.limits.Timeout = 300 * time.Millisecond
	start := time.Now()
	sum, err := s.Search(t.Context(), []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"}, func([]File) error { return nil })
	if err != nil || !sum.TimedOut || !sum.Truncated() {
		t.Errorf("Search = %+v, %v; want a timed-out summary", sum, err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("took %v", d)
	}
}

func TestSearchMissingRipgrep(t *testing.T) {
	dir := repo(t, map[string]string{"a.txt": "needle\n"})
	calls := 0
	engine := ripgrep.NewEngine(func() (ripgrep.Binary, error) {
		calls++
		return ripgrep.Binary{}, fmt.Errorf("%w (no /x/code-foundry-rg)", ripgrep.ErrMissing)
	})
	s := New(fsx.NewFileIndex(nil), engine, nil)
	for range 2 {
		_, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"})
		if !errors.Is(err, ripgrep.ErrMissing) {
			t.Errorf("Search = %v, want ErrMissing", err)
		}
	}
	if calls != 1 {
		t.Errorf("ripgrep was looked for %d times, want once", calls)
	}
	// A broken one: found, but it does not run as ripgrep.
	broken := ripgreptest.Fake(t, t.TempDir(), "rg", "", 3)
	s = New(fsx.NewFileIndex(nil), ripgrep.NewEngine(func() (ripgrep.Binary, error) { return ripgrep.Binary{Path: broken}, nil }), nil)
	if _, _, err := search(t, s, []fsx.Source{{Dir: dir, Git: true}}, Query{Text: "needle"}); !errors.Is(err, ripgrep.ErrBroken) {
		t.Errorf("Search = %v, want ErrBroken", err)
	}
}

func TestPlan(t *testing.T) {
	entries := func(n int) []fsx.FileEntry {
		out := make([]fsx.FileEntry, n)
		for i := range out {
			out[i].Path = fmt.Sprintf("f%d", i)
		}
		return out
	}
	chunks := plan([]fsx.Source{{Dir: "/a"}, {Dir: "/b"}}, [][]fsx.FileEntry{entries(1000), entries(20000)})
	var got []string
	for _, c := range chunks {
		got = append(got, fmt.Sprintf("%s:%d@%d", c.dir, len(c.files), c.first))
	}
	want := []string{"/a:128@0", "/a:512@128", "/a:360@640", "/b:8192@1000", "/b:8192@9192", "/b:3616@17384"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("plan\n got %v\nwant %v", got, want)
	}
	// Long paths: a chunk stops at maxChunkBytes of paths.
	long := entries(200)
	for i := range long {
		long[i].Path = strings.Repeat("p", 4095)
	}
	for _, c := range plan([]fsx.Source{{Dir: "/a"}}, [][]fsx.FileEntry{long}) {
		if len(c.files)*4096 > maxChunkBytes {
			t.Errorf("chunk of %d paths of 4 KiB", len(c.files))
		}
	}
}
