package fsx

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
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
			got, truncated, err := searchDir(context.Background(), x, tt.dir, tt.git, tt.query, tt.limit)
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
		got, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0)
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

// A lookup drops the lists past their TTL, even when the listing it starts fails, so an
// expired list is not held until some other listing succeeds.
func TestFileIndexLookupDropsExpired(t *testing.T) {
	now := time.Unix(1000, 0)
	x := NewFileIndex(nil)
	x.now = func() time.Time { return now }
	x.list = func(_ context.Context, dir string, _ bool, _ []string) ([]FileEntry, bool, error) {
		if dir == "/b" {
			return nil, false, errors.New("cannot list")
		}
		return []FileEntry{{Path: "a.go"}}, false, nil
	}
	if _, _, err := searchDir(context.Background(), x, "/a", true, "a", 0); err != nil {
		t.Fatal(err)
	}
	now = now.Add(FileCacheTTL)
	if _, _, err := searchDir(context.Background(), x, "/b", true, "a", 0); err == nil {
		t.Fatal("listing /b: want an error")
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	if len(x.entries) != 0 {
		t.Fatalf("cached %d lists after the TTL, want none", len(x.entries))
	}
}

// searchDir is SearchSources over the one checkout dir.
func searchDir(ctx context.Context, x *FileIndex, dir string, git bool, query string, limit int) ([]FileEntry, bool, error) {
	ms, truncated, _, err := x.SearchSources(ctx, []Source{{Dir: dir, Git: git}}, query, limit, false)
	if err != nil {
		return nil, false, err
	}
	matches := make([]FileEntry, len(ms))
	for i, m := range ms {
		matches[i] = m.FileEntry
	}
	return matches, truncated, nil
}

// The TTL counts from the end of the listing, so a listing slower than the TTL is
// still reused by the next keystroke.
func TestFileIndexCacheSlowListing(t *testing.T) {
	dir := gitRepo(t)
	start := time.Unix(1000, 0)
	var calls int
	x := NewFileIndex(nil)
	x.now = func() time.Time {
		calls++
		switch calls {
		case 1: // the first search starts
			return start
		case 2: // its listing ends after the TTL
			return start.Add(FileCacheTTL + time.Second)
		default: // the next search, one second later
			return start.Add(FileCacheTTL + 2*time.Second)
		}
	}
	if _, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "new.go"), "package x\n")
	got, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("the second search listed again (%q): the first listing was cached already expired", paths(got))
	}
}

// A cancelled search returns at once while its listing goes on and fills the cache; a
// later search gets that listing's result without listing again.
func TestFileIndexListingOutlivesCancelledSearch(t *testing.T) {
	x := NewFileIndex(nil)
	var listings atomic.Int32
	started, release := make(chan struct{}), make(chan struct{})
	var listCtxErr error // set before the listing returns, read after a search sees it
	x.list = func(ctx context.Context, _ string, _ bool, _ []string) ([]FileEntry, bool, error) {
		listings.Add(1)
		close(started)
		<-release
		listCtxErr = ctx.Err()
		return []FileEntry{{Path: "a.go"}}, false, nil
	}
	search := func(ctx context.Context) ([]string, error) {
		got, _, err := searchDir(ctx, x, "/w", true, "a", 0)
		return paths(got), err
	}

	ctx1, cancel1 := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, err := search(ctx1)
		first <- err
	}()
	<-started
	cancel1()
	select {
	case err := <-first:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled search: err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the cancelled search waited for the listing")
	}

	// The second search starts while the listing is (most likely) still running and
	// waits for it; either way it must not list again.
	second := make(chan []string, 1)
	go func() {
		got, err := search(context.Background())
		if err != nil {
			t.Error(err)
		}
		second <- got
	}()
	close(release)
	if got := <-second; !slices.Equal(got, []string{"a.go"}) {
		t.Fatalf("second search = %q, want [a.go]", got)
	}
	if listCtxErr != nil {
		t.Fatalf("the listing's context ended with its first caller: %v", listCtxErr)
	}
	if got, err := search(context.Background()); err != nil || !slices.Equal(got, []string{"a.go"}) {
		t.Fatalf("cached search = %q, %v", got, err)
	}
	if n := listings.Load(); n != 1 {
		t.Fatalf("listed %d times, want 1", n)
	}
}

// Concurrent misses for one checkout share a single listing.
func TestFileIndexConcurrentMissesShareOneListing(t *testing.T) {
	x := NewFileIndex(nil)
	var listings atomic.Int32
	release := make(chan struct{})
	x.list = func(context.Context, string, bool, []string) ([]FileEntry, bool, error) {
		listings.Add(1)
		<-release
		return []FileEntry{{Path: "a.go"}}, false, nil
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			if got, _, err := searchDir(context.Background(), x, "/w", true, "", 0); err != nil || len(got) != 1 {
				t.Errorf("Search = %v, %v", got, err)
			}
		})
	}
	// Let every search reach the wait before the listing ends.
	for {
		x.mu.Lock()
		l := x.inflight["true:/w"]
		x.mu.Unlock()
		if l != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if n := listings.Load(); n != 1 {
		t.Fatalf("listed %d times, want 1", n)
	}
}

// Each checkout has its own entry, and concurrent searches over two checkouts (hits
// and misses) are safe and never serve one checkout's list for the other. Run with
// -race.
func TestFileIndexConcurrentCheckouts(t *testing.T) {
	a, b := gitRepo(t), realTemp(t)
	write(t, filepath.Join(b, "only-in-b.txt"), "x")
	x := NewFileIndex(nil)
	var wg sync.WaitGroup
	errs := make(chan error, 128)
	for i := range 64 {
		wg.Go(func() {
			dir, git, query, want := a, true, "index", "src/index.ts"
			if i%2 == 1 {
				dir, git, query, want = b, false, "only", "only-in-b.txt"
			}
			got, _, err := searchDir(context.Background(), x, dir, git, query, 0)
			if err != nil {
				errs <- err
				return
			}
			if g := paths(got); !slices.Equal(g, []string{want}) {
				errs <- fmt.Errorf("Search(%s, %q) = %q, want [%q]", dir, query, g, want)
			}
			if i%2 == 0 { // b's file never shows up in a
				if other, _, _ := searchDir(context.Background(), x, dir, git, "only-in-b", 0); len(other) != 0 {
					errs <- fmt.Errorf("checkout a returned b's file: %q", paths(other))
				}
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestFileIndexSearchSources(t *testing.T) {
	app := gitRepo(t) // README.md, src/index.ts, src/components/Composer.tsx, ...
	gh := realTemp(t)
	for _, p := range []string{"README.md", "src/tree.zig", "src/components/x.zig"} {
		mkdir(t, filepath.Dir(filepath.Join(gh, p)))
		write(t, filepath.Join(gh, p), "x")
	}
	appSrc := Source{Dir: app, Git: true, Name: "app"}
	ghSrc := Source{Dir: gh, Name: "ghostty-playground"}
	type hit struct {
		src     int
		path    string // "/" suffix for directories
		pathPos []int
		namePos []int
	}
	tests := []struct {
		name      string
		sources   []Source
		query     string
		filesOnly bool
		limit     int
		want      []hit
		wantTrunc bool
	}{
		{"one list, ties to the first source", []Source{appSrc, ghSrc}, "readme", false, 0,
			[]hit{{0, "README.md", []int{0, 1, 2, 3, 4, 5}, nil}, {1, "README.md", []int{0, 1, 2, 3, 4, 5}, nil}}, false},
		{"the other order", []Source{ghSrc, appSrc}, "readme", false, 0,
			[]hit{{0, "README.md", []int{0, 1, 2, 3, 4, 5}, nil}, {1, "README.md", []int{0, 1, 2, 3, 4, 5}, nil}}, false},
		{"directories and files", []Source{appSrc, ghSrc}, "components", false, 0,
			// Composer.tsx's ".tsx" puts "ts" on a boundary, so it outscores x.zig.
			[]hit{{0, "src/components/", nil, nil}, {1, "src/components/", nil, nil}, {0, "src/components/Composer.tsx", nil, nil},
				{1, "src/components/x.zig", nil, nil}}, false},
		{"files only", []Source{appSrc, ghSrc}, "components", true, 0,
			[]hit{{0, "src/components/Composer.tsx", nil, nil}, {1, "src/components/x.zig", nil, nil}}, false},
		{"files only, empty query", []Source{ghSrc}, "", true, 0,
			[]hit{{0, "README.md", nil, nil}, {0, "src/tree.zig", nil, nil}, {0, "src/components/x.zig", nil, nil}}, false},
		{"a project word", []Source{appSrc, ghSrc}, "ghostty tree", true, 0,
			[]hit{{1, "src/tree.zig", []int{4, 5, 6, 7}, []int{0, 1, 2, 3, 4, 5, 6}}}, false},
		{"the limit spans sources", []Source{appSrc, ghSrc}, "readme", false, 1,
			[]hit{{0, "README.md", nil, nil}}, true},
	}
	x := NewFileIndex(nil)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ms, truncated, _, err := x.SearchSources(context.Background(), tt.sources, tt.query, tt.limit, tt.filesOnly)
			if err != nil {
				t.Fatal(err)
			}
			var got []hit
			for i, m := range ms {
				p := m.Path
				if m.IsDir {
					p += "/"
				}
				got = append(got, hit{m.Source, p, nil, nil})
				if i < len(tt.want) && tt.want[i].pathPos != nil {
					if !slices.Equal(m.PathPositions, tt.want[i].pathPos) || !slices.Equal(m.NamePositions, tt.want[i].namePos) {
						t.Fatalf("%q: positions %v / %v, want %v / %v", p, m.PathPositions, m.NamePositions, tt.want[i].pathPos, tt.want[i].namePos)
					}
				}
			}
			if !slices.EqualFunc(got, tt.want, func(a, b hit) bool { return a.src == b.src && a.path == b.path }) {
				t.Fatalf("SearchSources(%q) = %v, want %v", tt.query, got, tt.want)
			}
			if truncated != tt.wantTrunc {
				t.Fatalf("truncated = %v, want %v", truncated, tt.wantTrunc)
			}
		})
	}
}

// The sources are listed at the same time, not one after another, and one failing
// listing fails the search.
func TestFileIndexSearchSourcesListsConcurrently(t *testing.T) {
	x := NewFileIndex(nil)
	var started sync.WaitGroup
	started.Add(2)
	x.list = func(_ context.Context, dir string, _ bool, _ []string) ([]FileEntry, bool, error) {
		started.Done()
		started.Wait() // both listings must be running for either to finish
		if dir == "/bad" {
			return nil, false, errors.New("boom")
		}
		return []FileEntry{{Path: "a.go"}}, false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, _, err := x.SearchSources(ctx, []Source{{Dir: "/a"}, {Dir: "/bad"}}, "", 0, false)
	if err == nil || err.Error() != "list /bad: boom" {
		t.Fatalf("err = %v, want list /bad: boom", err)
	}
	// The good source's list is cached; the bad one is listed again.
	x.list = func(context.Context, string, bool, []string) ([]FileEntry, bool, error) {
		return []FileEntry{{Path: "b.go"}}, false, nil
	}
	ms, _, _, err := x.SearchSources(ctx, []Source{{Dir: "/a"}, {Dir: "/bad"}}, "", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].Path != "a.go" || ms[1].Path != "b.go" {
		t.Fatalf("matches = %+v", ms)
	}
}

// Files hands text search the cached lists file search ranks: files only, by path, without
// paths a protobuf string cannot carry, and no second listing.
func TestFileIndexFiles(t *testing.T) {
	x := NewFileIndex(nil)
	var listings atomic.Int32
	x.list = func(_ context.Context, dir string, _ bool, _ []string) ([]FileEntry, bool, error) {
		listings.Add(1)
		if dir == "/b" {
			return []FileEntry{{Path: "z.go"}}, false, nil
		}
		return []FileEntry{
			{Path: "src", IsDir: true}, {Path: "src/b.go"}, {Path: "a.go"}, {Path: "bad\xff.go"},
			{Path: ".env", Ignored: true}, {Path: "src/a.go"},
		}, false, nil
	}
	srcs := []Source{{Dir: "/a", Git: true}, {Dir: "/b", Git: true}}
	if _, _, _, err := x.SearchSources(context.Background(), srcs, "go", 10, true); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		lists, _, err := x.Files(context.Background(), srcs)
		if err != nil {
			t.Fatal(err)
		}
		want := [][]FileEntry{
			{{Path: ".env", Ignored: true}, {Path: "a.go"}, {Path: "src/a.go"}, {Path: "src/b.go"}},
			{{Path: "z.go"}},
		}
		if !reflect.DeepEqual(lists, want) {
			t.Errorf("Files = %v, want %v", lists, want)
		}
	}
	if n := listings.Load(); n != 2 {
		t.Errorf("%d listings, want one per checkout", n)
	}
}

// A source whose included ignored files were cut at MaxIncludedFiles says so through both
// file search and the lists text search reads, so the finder can tell a "no matches" that
// may be wrong.
func TestFileIndexIncludeCapped(t *testing.T) {
	x := NewFileIndex(nil)
	x.list = func(_ context.Context, dir string, _ bool, _ []string) ([]FileEntry, bool, error) {
		return []FileEntry{{Path: "a.go"}}, dir == "/big", nil
	}
	tests := []struct {
		name    string
		sources []Source
		want    bool
	}{
		{"none capped", []Source{{Dir: "/a"}}, false},
		{"the one source capped", []Source{{Dir: "/big"}}, true},
		{"one of two capped", []Source{{Dir: "/a"}, {Dir: "/big"}}, true},
		{"the capped one first", []Source{{Dir: "/big"}, {Dir: "/a"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, capped, err := x.SearchSources(context.Background(), tt.sources, "a", 0, false)
			if err != nil || capped != tt.want {
				t.Errorf("SearchSources includeCapped = %t, %v; want %t", capped, err, tt.want)
			}
			_, capped, err = x.Files(context.Background(), tt.sources)
			if err != nil || capped != tt.want {
				t.Errorf("Files includeCapped = %t, %v; want %t", capped, err, tt.want)
			}
		})
	}
}

// Watched checkouts reuse their cached file list past FileCacheTTL up to
// WatchedFileCacheTTL, and Invalidate clears them immediately (including preventing an
// in-flight pre-invalidation listing from poisoning the cache).
func TestFileIndexWatchedTTLAndInvalidate(t *testing.T) {
	dir := gitRepo(t)
	now := time.Unix(1000, 0)
	x := NewFileIndex(nil)
	x.now = func() time.Time { return now }
	var listings atomic.Int32
	origList := x.list
	x.list = func(ctx context.Context, d string, g bool, inc []string) ([]FileEntry, bool, error) {
		listings.Add(1)
		return origList(ctx, d, g, inc)
	}
	x.SetWatched(dir, true)

	if _, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "new.go"), "package x\n")

	// Past 5s FileCacheTTL, still cached because dir is watched.
	now = now.Add(30 * time.Second)
	if got, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0); err != nil || len(got) != 0 {
		t.Fatalf("within WatchedFileCacheTTL: got %q, err %v", paths(got), err)
	}
	if n := listings.Load(); n != 1 {
		t.Fatalf("listings = %d, want 1", n)
	}

	// Explicit Invalidate clears immediately.
	x.Invalidate(dir)
	if got, _, err := searchDir(context.Background(), x, dir, true, "new.go", 0); err != nil || !slices.Equal(paths(got), []string{"new.go"}) {
		t.Fatalf("after Invalidate: got %q, err %v", paths(got), err)
	}
	if n := listings.Load(); n != 2 {
		t.Fatalf("listings = %d, want 2", n)
	}

	// Past WatchedFileCacheTTL, expires as backstop.
	write(t, filepath.Join(dir, "later.go"), "package x\n")
	now = now.Add(WatchedFileCacheTTL)
	if got, _, err := searchDir(context.Background(), x, dir, true, "later.go", 0); err != nil || !slices.Equal(paths(got), []string{"later.go"}) {
		t.Fatalf("after WatchedFileCacheTTL: got %q, err %v", paths(got), err)
	}

	// Marking unwatched restores FileCacheTTL.
	x.SetWatched(dir, false)
	write(t, filepath.Join(dir, "unwatched.go"), "package x\n")
	now = now.Add(FileCacheTTL)
	if got, _, err := searchDir(context.Background(), x, dir, true, "unwatched.go", 0); err != nil || !slices.Equal(paths(got), []string{"unwatched.go"}) {
		t.Fatalf("after SetWatched(false) + FileCacheTTL: got %q, err %v", paths(got), err)
	}
}

// An Invalidate while a listing is in flight prevents that stale listing from being
// cached and lets a subsequent search start a fresh listing immediately.
func TestFileIndexInvalidateDuringInflight(t *testing.T) {
	x := NewFileIndex(nil)
	x.SetWatched("/w", true)
	started := make(chan struct{})
	release := make(chan struct{})
	var call atomic.Int32
	x.list = func(context.Context, string, bool, []string) ([]FileEntry, bool, error) {
		n := call.Add(1)
		if n == 1 {
			close(started)
			<-release
			return []FileEntry{{Path: "old.go"}}, false, nil
		}
		return []FileEntry{{Path: "fresh.go"}}, false, nil
	}

	firstDone := make(chan []string, 1)
	go func() {
		got, _, _ := searchDir(context.Background(), x, "/w", true, "", 0)
		firstDone <- paths(got)
	}()
	<-started

	// Invalidate while first listing is still running.
	x.Invalidate("/w")

	// Second search starts a new listing immediately and gets fresh.go.
	got2, _, err := searchDir(context.Background(), x, "/w", true, "", 0)
	if err != nil || !slices.Equal(paths(got2), []string{"fresh.go"}) {
		t.Fatalf("second search = %q, %v; want [fresh.go]", paths(got2), err)
	}

	// Release the stale first listing: its waiter gets old.go, but the cache keeps fresh.go.
	close(release)
	if got1 := <-firstDone; !slices.Equal(got1, []string{"old.go"}) {
		t.Fatalf("first waiter = %q, want [old.go]", got1)
	}
	got3, _, err := searchDir(context.Background(), x, "/w", true, "", 0)
	if err != nil || !slices.Equal(paths(got3), []string{"fresh.go"}) {
		t.Fatalf("cached search = %q, %v; want [fresh.go]", paths(got3), err)
	}
	if n := call.Load(); n != 2 {
		t.Fatalf("list calls = %d, want 2", n)
	}
}

// Entries with Include patterns stay on FileCacheTTL (5s) even on watched roots because
// WorktreeFilesChanged does not emit git-ignored files, and transitioning a root from
// unwatched to watched invalidates any pre-watch cached entry.
func TestFileIndexIncludeIgnoredKeepsShortTTLAndWatchInvalidates(t *testing.T) {
	now := time.Unix(2000, 0)
	x := NewFileIndex(nil)
	x.now = func() time.Time { return now }
	var calls atomic.Int32
	x.list = func(_ context.Context, _ string, _ bool, _ []string) ([]FileEntry, bool, error) {
		n := calls.Add(1)
		return []FileEntry{{Path: fmt.Sprintf("v%d.env", n)}}, false, nil
	}

	// Unwatched root cached first; SetWatched(true) invalidates it instead of promoting to 5m.
	if _, _, err := searchDir(context.Background(), x, "/w", true, "", 0); err != nil {
		t.Fatal(err)
	}
	x.SetWatched("/w", true)
	got, _, err := searchDir(context.Background(), x, "/w", true, "", 0)
	if err != nil || !slices.Equal(paths(got), []string{"v2.env"}) {
		t.Fatalf("after SetWatched(true): got %q, %v; want [v2.env]", paths(got), err)
	}

	// With Include patterns on a watched root, FileCacheTTL (5s) still applies.
	src := []Source{{Dir: "/w", Git: true, Include: []string{".env"}}}
	if _, _, _, err := x.SearchSources(context.Background(), src, "", 0, false); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	now = now.Add(FileCacheTTL)
	if _, _, _, err := x.SearchSources(context.Background(), src, "", 0, false); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != before+1 {
		t.Fatalf("Include listing calls after FileCacheTTL = %d, want %d", calls.Load(), before+1)
	}
}
