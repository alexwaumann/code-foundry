package gh

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// rawCall is one raw REST request a fakeRaw received.
type rawCall struct {
	path, ref, accept string
	limit             int64
}

// fakeRaw is a fakeRunner that also answers raw REST GETs (RawRESTRunner) with answer.
type fakeRaw struct {
	*fakeRunner
	mu     sync.Mutex
	raws   []rawCall
	answer func(path, ref string, limit int64) (RawResponse, error)
}

func (f *fakeRaw) RESTRaw(_ context.Context, path string, params map[string]string, accept string, limit int64) (RawResponse, error) {
	f.mu.Lock()
	f.raws = append(f.raws, rawCall{path, params["ref"], accept, limit})
	answer := f.answer
	f.mu.Unlock()
	return answer(path, params["ref"], limit)
}

func (f *fakeRaw) calls() []rawCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.raws)
}

func newFakeRaw(answer func(path, ref string, limit int64) (RawResponse, error)) *fakeRaw {
	return &fakeRaw{fakeRunner: (&fakeRunner{}).serve(newFakeGitHub()), answer: answer}
}

func TestPullRequestDiffCache(t *testing.T) {
	ctx := context.Background()
	n := 0
	f := newFakeRaw(func(path, _ string, _ int64) (RawResponse, error) {
		n++
		return RawResponse{Body: fmt.Appendf(nil, "diff --git a/x b/x\n# fetch %d of %s\n", n, path)}, nil
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	headA, headB, base := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("c", 40)
	k := fullKey{slug: "o/r", number: 7}
	s.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 7, Repo: "o/r", HeadSHA: headA, BaseSHA: base}})

	steps := []struct {
		name     string
		number   int
		refresh  bool
		setHead  string // re-cache #7 with this head first
		wantN    int    // raw requests so far
		wantHead string
	}{
		{name: "first fetch", number: 7, wantN: 1, wantHead: headA},
		{name: "same head is cached", number: 7, wantN: 1, wantHead: headA},
		{name: "refresh bypasses", number: 7, refresh: true, wantN: 2, wantHead: headA},
		{name: "new head fetches", number: 7, setHead: headB, wantN: 3, wantHead: headB},
		{name: "new head cached", number: 7, wantN: 3, wantHead: headB},
		{name: "uncached pull request fetches", number: 8, wantN: 4},
		{name: "and fetches again", number: 8, wantN: 5},
	}
	for _, st := range steps {
		if st.setHead != "" {
			s.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 7, Repo: "o/r", HeadSHA: st.setHead, BaseSHA: base}})
		}
		d, err := s.PullRequestDiff(ctx, "O/R", st.number, st.refresh)
		if err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		if got := len(f.calls()); got != st.wantN {
			t.Errorf("%s: requests = %d, want %d", st.name, got, st.wantN)
		}
		if d.HeadSHA != st.wantHead || !strings.HasPrefix(d.Diff, "diff --git") || d.FetchedAt.IsZero() {
			t.Errorf("%s: diff = %+v", st.name, d)
		}
	}
	c := f.calls()[0]
	if c.path != "repos/o/r/pulls/7" || c.accept != "application/vnd.github.v3.diff" || c.limit != PullRequestDiffMax {
		t.Errorf("request = %+v", c)
	}
}

func TestPullRequestDiffTruncatedAndRefused(t *testing.T) {
	ctx := context.Background()
	f := newFakeRaw(func(string, string, int64) (RawResponse, error) {
		return RawResponse{Body: []byte("line one\nline two\nline thr"), Truncated: true}, nil
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	d, err := s.PullRequestDiff(ctx, "o/r", 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if d.Diff != "line one\nline two\n" || !d.Truncated {
		t.Errorf("diff = %q truncated %t, want whole lines and truncated", d.Diff, d.Truncated)
	}

	f.mu.Lock()
	f.answer = func(string, string, int64) (RawResponse, error) {
		return RawResponse{}, fmt.Errorf("%w: diff too large (HTTP 406)", ErrFailedPrecondition)
	}
	f.mu.Unlock()
	if _, err := s.PullRequestDiff(ctx, "o/r", 2, false); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("err = %v, want ErrFailedPrecondition", err)
	}
	if _, err := s.PullRequestDiff(ctx, "o/r", 0, false); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("number 0: err = %v, want ErrInvalidArgument", err)
	}
}

func TestPullRequestFile(t *testing.T) {
	ctx := context.Background()
	sha := strings.Repeat("d", 40)
	big := strings.Repeat("x", PullRequestFileMax)
	files := map[string]RawResponse{
		"repos/o/r/contents/README.md":            {Body: []byte("# r\n"), ContentType: "application/vnd.github.raw+json; charset=utf-8"},
		"repos/fork/r/contents/src/new%20file.go": {Body: []byte("package src\n"), ContentType: "application/vnd.github.raw+json"},
		"repos/o/r/contents/logo.png":             {Body: []byte("\x89PNG\x00"), ContentType: "application/vnd.github.raw+json"},
		"repos/o/r/contents/big.txt":              {Body: []byte(big), Truncated: true, ContentType: "application/vnd.github.raw+json"},
		"repos/o/r/contents/docs":                 {Body: []byte(`[{"name":"a.md"}]`), ContentType: "application/json; charset=utf-8"},
	}
	f := newFakeRaw(func(path, ref string, _ int64) (RawResponse, error) {
		if ref != sha {
			return RawResponse{}, fmt.Errorf("unexpected ref %q", ref)
		}
		if r, ok := files[path]; ok {
			return r, nil
		}
		return RawResponse{}, fmt.Errorf("%w: Not Found (HTTP 404)", ErrNotFound)
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))

	tests := []struct {
		name, slug, path string
		want             PullRequestFile
	}{
		{name: "text", slug: "o/r", path: "README.md", want: PullRequestFile{Contents: []byte("# r\n")}},
		{name: "head repository override", slug: "Fork/R", path: "src/new file.go", want: PullRequestFile{Contents: []byte("package src\n")}},
		{name: "binary", slug: "o/r", path: "logo.png", want: PullRequestFile{Contents: []byte("\x89PNG\x00"), Binary: true}},
		{name: "truncated", slug: "o/r", path: "big.txt", want: PullRequestFile{Contents: []byte(big), Truncated: true}},
		{name: "directory", slug: "o/r", path: "docs", want: PullRequestFile{NotFound: true}},
		{name: "missing", slug: "o/r", path: "nope.txt", want: PullRequestFile{NotFound: true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for range 2 { // the second call is served from the cache
				got, err := s.PullRequestFile(ctx, tt.slug, sha, tt.path)
				if err != nil {
					t.Fatal(err)
				}
				if string(got.Contents) != string(tt.want.Contents) || got.Truncated != tt.want.Truncated ||
					got.Binary != tt.want.Binary || got.NotFound != tt.want.NotFound {
					t.Errorf("got %+v, want %+v", got, tt.want)
				}
			}
		})
	}
	calls := f.calls()
	if len(calls) != len(tests) {
		t.Errorf("requests = %d, want %d (one per file)", len(calls), len(tests))
	}
	if c := calls[0]; c.accept != "application/vnd.github.raw+json" || c.limit != PullRequestFileMax {
		t.Errorf("request = %+v", c)
	}

	for _, bad := range []struct{ ref, path string }{
		{"main", "README.md"}, {sha, ""}, {sha, "/etc/passwd"}, {sha, "../x"}, {sha, "."},
	} {
		if _, err := s.PullRequestFile(ctx, "o/r", bad.ref, bad.path); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("ref %q path %q: err = %v, want ErrInvalidArgument", bad.ref, bad.path, err)
		}
	}
}

func TestPullRequestFilesNeedRawRunner(t *testing.T) {
	s := startStore(t, testOptions(openTestDB(t), (&fakeRunner{}).serve(newFakeGitHub()), nil))
	if _, err := s.PullRequestDiff(context.Background(), "o/r", 1, false); err == nil {
		t.Error("diff: want an error without a RawRESTRunner")
	}
	if _, err := s.PullRequestFile(context.Background(), "o/r", strings.Repeat("a", 40), "x"); err == nil {
		t.Error("file: want an error without a RawRESTRunner")
	}
}

func TestPullRequestFileCacheBounds(t *testing.T) {
	var c prFilesCache
	chunk := make([]byte, fileCacheBytes/4)
	for i := range 6 {
		c.putFile(fileKey{slug: "o/r", ref: "a", path: fmt.Sprint(i)}, PullRequestFile{Contents: chunk})
	}
	if len(c.files) != 4 || c.fileBytes != fileCacheBytes {
		t.Errorf("files = %d bytes = %d, want 4 and %d", len(c.files), c.fileBytes, fileCacheBytes)
	}
	if _, ok := c.file(fileKey{slug: "o/r", ref: "a", path: "1"}); ok {
		t.Error("the oldest files should be gone")
	}
	for i := range fileCacheMax + 5 {
		c.putFile(fileKey{slug: "o/r", ref: "b", path: fmt.Sprint(i)}, PullRequestFile{NotFound: true})
	}
	if len(c.files) != fileCacheMax {
		t.Errorf("files = %d, want %d", len(c.files), fileCacheMax)
	}
}

func TestHTTPRunnerRESTRaw(t *testing.T) {
	ctx := context.Background()
	srv := newAPIServer(t, "tok1", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/o/r/pulls/1":
			w.Header().Set("Content-Type", "application/vnd.github.v3.diff; charset=utf-8")
			_, _ = w.Write([]byte("diff --git a/x b/x\n+1\n"))
		case "/repos/o/r/pulls/2":
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusNotAcceptable)
			_, _ = w.Write([]byte(`{"message":"Sorry, the diff exceeded the maximum number of lines (20000)","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}`))
		case "/repos/o/r/contents/a b.txt":
			w.Header().Set("Content-Type", "application/vnd.github.raw+json")
			_, _ = w.Write([]byte("0123456789"))
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Not Found"}`))
		}
	})
	r := NewHTTPRunner(HTTPOptions{BaseURL: srv.URL, Tokens: &fakeTokens{tokens: []string{"tok1"}}})

	res, err := r.RESTRaw(ctx, "repos/o/r/pulls/1", nil, acceptDiff, 1<<20)
	if err != nil || string(res.Body) != "diff --git a/x b/x\n+1\n" || res.Truncated || !strings.HasPrefix(res.ContentType, "application/vnd.github.v3.diff") {
		t.Errorf("diff = %+v, %v", res, err)
	}
	if _, err := r.RESTRaw(ctx, "repos/o/r/pulls/2", nil, acceptDiff, 1<<20); !errors.Is(err, ErrFailedPrecondition) ||
		!strings.Contains(err.Error(), "maximum number of lines") {
		t.Errorf("too large: err = %v, want ErrFailedPrecondition with GitHub's message", err)
	}
	res, err = r.RESTRaw(ctx, "repos/o/r/contents/a%20b.txt", map[string]string{"ref": "abc"}, acceptRaw, 4)
	if err != nil || string(res.Body) != "0123" || !res.Truncated {
		t.Errorf("limited = %+v, %v; want 4 bytes and truncated", res, err)
	}
	if _, err := r.RESTRaw(ctx, "repos/o/r/contents/nope", nil, acceptRaw, 4); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: err = %v, want ErrNotFound", err)
	}
	if _, err := r.RESTRaw(ctx, "x", nil, "", 4); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("no accept: err = %v, want ErrInvalidArgument", err)
	}
	reqs := srv.requests()
	if reqs[0].accept != acceptDiff || reqs[2].accept != acceptRaw || reqs[2].query != "ref=abc" {
		t.Errorf("requests = %+v", reqs)
	}
	// The JSON path is unchanged: its default Accept and the full body.
	if _, err := r.REST(ctx, "repos/o/r/missing", nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("REST: err = %v", err)
	}
	if got := srv.requests()[len(reqs)].accept; got != "application/vnd.github+json" {
		t.Errorf("REST accept = %q", got)
	}
}

type fakeLocalGit struct {
	mu        sync.Mutex
	diffCalls int
	fileCalls int
	diffFn    func(slug, base, head string, maxBytes int) ([]byte, bool, bool)
	fileFn    func(slug, sha, path string, maxBytes int) ([]byte, bool, bool, bool, bool)
}

func (f *fakeLocalGit) LocalPRDiff(_ context.Context, slug, baseSHA, headSHA string, maxBytes int) ([]byte, bool, bool) {
	f.mu.Lock()
	f.diffCalls++
	fn := f.diffFn
	f.mu.Unlock()
	if fn == nil {
		return nil, false, false
	}
	return fn(slug, baseSHA, headSHA, maxBytes)
}

func (f *fakeLocalGit) LocalPRFile(_ context.Context, slug, commitSHA, filePath string, maxBytes int) ([]byte, bool, bool, bool, bool) {
	f.mu.Lock()
	f.fileCalls++
	fn := f.fileFn
	f.mu.Unlock()
	if fn == nil {
		return nil, false, false, false, false
	}
	return fn(slug, commitSHA, filePath, maxBytes)
}

func TestPullRequestDiffLocalGitAndFallback(t *testing.T) {
	ctx := context.Background()
	base1, base2 := strings.Repeat("1", 40), strings.Repeat("2", 40)
	head1, head2 := strings.Repeat("a", 40), strings.Repeat("b", 40)

	restFetches := 0
	raw := newFakeRaw(func(path, _ string, _ int64) (RawResponse, error) {
		restFetches++
		return RawResponse{Body: fmt.Appendf(nil, "diff --git a/rest b/rest\n# rest %d %s\n", restFetches, path)}, nil
	})
	lg := &fakeLocalGit{
		diffFn: func(slug, base, head string, _ int) ([]byte, bool, bool) {
			if slug == "o/r" && base == base1 && head == head1 {
				return []byte("diff --git a/local b/local\n+line\npartial"), true, true
			}
			return nil, false, false
		},
	}
	opts := testOptions(openTestDB(t), raw, nil)
	opts.LocalGit = lg
	s := startStore(t, opts)

	// Seed only summaries (not FullPullRequest): local git still resolves base+head.
	k := fullKey{slug: "o/r", number: 7}
	s.summaries.put(k, PullRequest{Number: 7, Repo: "o/r", BaseSHA: base1, HeadSHA: head1})

	d, err := s.PullRequestDiff(ctx, "O/R", 7, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.calls()) != 0 {
		t.Fatalf("expected 0 REST calls on local git hit, got %d", len(raw.calls()))
	}
	if d.Diff != "diff --git a/local b/local\n+line\n" || !d.Truncated || d.HeadSHA != head1 || d.BaseSHA != base1 {
		t.Errorf("local diff = %+v", d)
	}

	// Second call hits in-memory cache without re-running local git.
	if _, err := s.PullRequestDiff(ctx, "o/r", 7, false); err != nil {
		t.Fatal(err)
	}
	if lg.diffCalls != 1 || len(raw.calls()) != 0 {
		t.Errorf("expected mem hit: diffCalls=%d rest=%d", lg.diffCalls, len(raw.calls()))
	}

	// refresh=true bypasses memory, local git, and SQLite and hits GitHub REST.
	d, err = s.PullRequestDiff(ctx, "o/r", 7, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.calls()) != 1 || !strings.Contains(d.Diff, "# rest 1") {
		t.Errorf("refresh should hit REST: rest=%d diff=%q", len(raw.calls()), d.Diff)
	}

	// Missing local object (head2) falls back seamlessly to GitHub REST.
	s.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 7, Repo: "o/r", BaseSHA: base1, HeadSHA: head2}})
	d, err = s.PullRequestDiff(ctx, "o/r", 7, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.calls()) != 2 || !strings.Contains(d.Diff, "# rest 2") {
		t.Errorf("local miss should fall back to REST: rest=%d diff=%q", len(raw.calls()), d.Diff)
	}

	// BaseSHA changing invalidates the in-memory and SQLite diff cache.
	s.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 7, Repo: "o/r", BaseSHA: base2, HeadSHA: head2}})
	d, err = s.PullRequestDiff(ctx, "o/r", 7, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw.calls()) != 3 || d.BaseSHA != base2 {
		t.Errorf("base change should refetch: rest=%d diff=%+v", len(raw.calls()), d)
	}
}

func TestPullRequestFileLocalGitAndFallback(t *testing.T) {
	ctx := context.Background()
	sha := strings.Repeat("d", 40)
	missingSHA := strings.Repeat("e", 40)

	raw := newFakeRaw(func(path, _ string, _ int64) (RawResponse, error) {
		return RawResponse{Body: []byte("from-rest:" + path), ContentType: "application/vnd.github.raw+json"}, nil
	})
	lg := &fakeLocalGit{
		fileFn: func(slug, commit, p string, _ int) ([]byte, bool, bool, bool, bool) {
			if slug != "o/r" || commit != sha {
				return nil, false, false, false, false
			}
			switch p {
			case "README.md":
				return []byte("local readme\n"), false, false, false, true
			case "missing.txt":
				return nil, false, false, true, true
			case "img.png":
				return []byte("\x89PNG\x00"), false, true, false, true
			}
			return nil, false, false, false, false
		},
	}
	opts := testOptions(openTestDB(t), raw, nil)
	opts.LocalGit = lg
	s := startStore(t, opts)

	f, err := s.PullRequestFile(ctx, "o/r", sha, "README.md")
	if err != nil || string(f.Contents) != "local readme\n" || f.Binary || f.NotFound || len(raw.calls()) != 0 {
		t.Fatalf("local text file = %+v err=%v rest=%d", f, err, len(raw.calls()))
	}
	// Cached in memory on second call.
	if _, err := s.PullRequestFile(ctx, "o/r", sha, "README.md"); err != nil {
		t.Fatal(err)
	}
	if lg.fileCalls != 1 {
		t.Errorf("fileCalls = %d, want 1 (in-memory hit)", lg.fileCalls)
	}
	f, err = s.PullRequestFile(ctx, "o/r", sha, "missing.txt")
	if err != nil || !f.NotFound || len(raw.calls()) != 0 {
		t.Fatalf("local missing file = %+v err=%v rest=%d", f, err, len(raw.calls()))
	}
	f, err = s.PullRequestFile(ctx, "o/r", sha, "img.png")
	if err != nil || !f.Binary || len(raw.calls()) != 0 {
		t.Fatalf("local binary file = %+v err=%v rest=%d", f, err, len(raw.calls()))
	}

	// Commit not present locally falls back to GitHub REST.
	f, err = s.PullRequestFile(ctx, "o/r", missingSHA, "README.md")
	if err != nil || string(f.Contents) != "from-rest:repos/o/r/contents/README.md" || len(raw.calls()) != 1 {
		t.Fatalf("fallback file = %+v err=%v rest=%d", f, err, len(raw.calls()))
	}
}

func TestPullRequestDiffSQLitePersistenceAndCap(t *testing.T) {
	ctx := context.Background()
	db := openTestDB(t)
	clk := &testClock{}
	base, head1, head2 := strings.Repeat("c", 40), strings.Repeat("a", 40), strings.Repeat("b", 40)

	raw1 := newFakeRaw(func(path, _ string, _ int64) (RawResponse, error) {
		return RawResponse{Body: []byte("diff --git a/x b/x\n+persisted\n")}, nil
	})
	opts1 := testOptions(db, raw1, nil)
	opts1.Now = clk.now
	s1 := startStore(t, opts1)
	k := fullKey{slug: "fork/repo", number: 42}
	s1.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 42, Repo: "fork/repo", HeadSHA: head1, BaseSHA: base}})
	d1, err := s1.PullRequestDiff(ctx, "fork/repo", 42, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw1.calls()) != 1 || d1.Diff != "diff --git a/x b/x\n+persisted\n" {
		t.Fatalf("store1 diff = %+v rest=%d", d1, len(raw1.calls()))
	}

	// Simulate daemon restart: new Store on the same DB, empty in-memory cache.
	raw2 := newFakeRaw(func(path, _ string, _ int64) (RawResponse, error) {
		return RawResponse{Body: []byte("diff --git a/x b/x\n+refetched\n")}, nil
	})
	opts2 := testOptions(db, raw2, nil)
	opts2.Now = clk.now
	s2 := startStore(t, opts2)
	s2.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 42, Repo: "fork/repo", HeadSHA: head1, BaseSHA: base}})

	d2, err := s2.PullRequestDiff(ctx, "fork/repo", 42, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw2.calls()) != 0 {
		t.Fatalf("after restart expected 0 REST calls (SQLite hit), got %d", len(raw2.calls()))
	}
	if d2.Diff != d1.Diff || d2.HeadSHA != head1 || d2.BaseSHA != base {
		t.Errorf("after restart diff = %+v, want %+v", d2, d1)
	}

	// New head misses SQLite and fetches from REST.
	s2.full.put(k, FullPullRequest{PullRequest: PullRequest{Number: 42, Repo: "fork/repo", HeadSHA: head2, BaseSHA: base}})
	d3, err := s2.PullRequestDiff(ctx, "fork/repo", 42, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw2.calls()) != 1 || !strings.Contains(d3.Diff, "+refetched") {
		t.Errorf("new head diff = %+v rest=%d", d3, len(raw2.calls()))
	}

	// Bounded cap: saving diffDBCacheMax+8 entries keeps only the newest diffDBCacheMax rows.
	for i := 1; i <= diffDBCacheMax+8; i++ {
		clk.advance(time.Second)
		if err := s2.cache.savePRDiff(ctx, "cap/repo", i, PullRequestDiff{
			Diff: fmt.Sprintf("diff #%d\n", i), HeadSHA: head1, BaseSHA: base, FetchedAt: clk.now(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM gh_pr_diffs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != diffDBCacheMax {
		t.Errorf("gh_pr_diffs row count = %d, want %d", count, diffDBCacheMax)
	}
	// The oldest entries were evicted, the newest survived.
	if _, found, err := s2.cache.loadPRDiff(ctx, "cap/repo", 1); err != nil || found {
		t.Errorf("oldest row #1 should be pruned: found=%v err=%v", found, err)
	}
	if _, found, err := s2.cache.loadPRDiff(ctx, "cap/repo", diffDBCacheMax+8); err != nil || !found {
		t.Errorf("newest row should survive: found=%v err=%v", found, err)
	}

	// Age pruning on startup drops rows older than cacheRetention.
	clk.advance(cacheRetention + time.Hour)
	if err := s2.cache.prune(ctx, clk.now()); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM gh_pr_diffs`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Errorf("after retention prune gh_pr_diffs count = %d, want 0", count)
	}
}
