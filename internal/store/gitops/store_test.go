package gitops

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/repo"
	"github.com/awaumann/code-foundry/internal/store/repo/repotest"
)

// isolateGit keeps a developer's global git config (signing, hooks) out of the tests.
func isolateGit(t *testing.T) {
	t.Helper()
	cfg := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(cfg, []byte("[user]\n\tname = Test\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", cfg)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func commit(t *testing.T, dir, file, content, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, dir, "add", file)
	git(t, dir, "commit", "-q", "-m", msg)
}

// world is a bare origin with two clones, a and b, both on main and in sync.
type world struct {
	origin, a, b string
	repos        *repotest.Fake
	bus          *bus.Bus
	m            *Manager
}

func resolved(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func newWorld(t *testing.T, opts Options) *world {
	t.Helper()
	isolateGit(t)
	root := resolved(t, t.TempDir())
	w := &world{origin: filepath.Join(root, "origin.git"), a: filepath.Join(root, "a"), b: filepath.Join(root, "b"), bus: bus.New()}
	git(t, root, "init", "-q", "--bare", w.origin)
	git(t, root, "clone", "-q", w.origin, w.a)
	commit(t, w.a, "README", "hello\n", "initial")
	git(t, w.a, "push", "-q", "-u", "origin", "main")
	git(t, root, "clone", "-q", w.origin, w.b)

	w.repos = repotest.New(w.bus)
	w.repos.Put(repo.Repo{ID: "ra", Path: w.a, Name: "a", GitHubSlug: "me/a", Worktrees: []repo.Worktree{{RepoID: "ra", Path: w.a, Branch: "main", IsMain: true}}})
	opts.Bus, opts.Repos = w.bus, w.repos
	w.m = New(opts)
	t.Cleanup(func() { _ = w.m.Close() })
	return w
}

// mustOp(t)(store.Method(...)) fails the test on an error and returns the op.
func mustOp(t *testing.T) func(Op, error) Op {
	return func(op Op, err error) Op {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
}

func wantOK(t *testing.T, op Op, summary string) {
	t.Helper()
	if !op.OK() {
		t.Fatalf("%s failed: %s\n%s", op.Title, op.Summary, op.Output)
	}
	if summary != "" && op.Summary != summary {
		t.Errorf("%s summary = %q, want %q\n%s", op.Title, op.Summary, summary, op.Output)
	}
}

func wantFailed(t *testing.T, op Op, contains string) {
	t.Helper()
	if op.OK() {
		t.Fatalf("%s succeeded (%s), want failure\n%s", op.Title, op.Summary, op.Output)
	}
	if !strings.Contains(op.Summary, contains) {
		t.Errorf("%s summary = %q, want it to contain %q\n%s", op.Title, op.Summary, contains, op.Output)
	}
}

func TestPushFetchPullRoundTrip(t *testing.T) {
	w := newWorld(t, Options{})
	ctx := context.Background()

	// New branch without upstream: push sets origin/<branch> as upstream.
	git(t, w.a, "switch", "-q", "-c", "feat")
	commit(t, w.a, "f.txt", "1\n", "feat: one")
	op := mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a}))
	wantOK(t, op, "pushed feat to origin (new branch)")
	if got := git(t, w.a, "rev-parse", "--abbrev-ref", "feat@{upstream}"); got != "origin/feat" {
		t.Errorf("upstream = %q, want origin/feat", got)
	}
	if !strings.Contains(op.Output, "$ git push -u origin feat") {
		t.Errorf("output lacks the push command:\n%s", op.Output)
	}
	if op.RepoID != "ra" || op.Branch != "feat" || op.Title != "Push feat" || op.WorktreePath != w.a || op.Duration <= 0 {
		t.Errorf("op = %+v", op)
	}

	// Pushing again: nothing to do.
	wantOK(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "already up to date")

	// b fetches the new branch, then fast-forwards main after a pushes to it.
	wantOK(t, mustOp(t)(w.m.Fetch(ctx, FetchOptions{WorktreePath: w.b})), "fetched 1 updated ref")
	wantOK(t, mustOp(t)(w.m.Fetch(ctx, FetchOptions{WorktreePath: w.b})), "already up to date")
	git(t, w.a, "switch", "-q", "main")
	commit(t, w.a, "m.txt", "m\n", "main: two")
	wantOK(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "pushed main to origin")
	op = mustOp(t)(w.m.Pull(ctx, PullOptions{WorktreePath: w.b}))
	wantOK(t, op, "fast-forwarded: 1 file changed, 1 insertion(+)")
	if git(t, w.b, "rev-parse", "HEAD") != git(t, w.a, "rev-parse", "HEAD") {
		t.Error("b is not at a's HEAD after pull")
	}
	wantOK(t, mustOp(t)(w.m.Pull(ctx, PullOptions{WorktreePath: w.b})), "already up to date")

	// Prune: the branch deleted on origin disappears from b's remote-tracking refs.
	git(t, w.a, "push", "-q", "origin", "--delete", "feat")
	wantOK(t, mustOp(t)(w.m.Fetch(ctx, FetchOptions{WorktreePath: w.b})), "pruned 1 ref")

	_ = w.m.Close()
	if !slices.Contains(w.repos.Calls, "Refresh ra") {
		t.Errorf("repo store was not refreshed after ops on a: %v", w.repos.Calls)
	}
}

func TestDivergedBranches(t *testing.T) {
	w := newWorld(t, Options{})
	ctx := context.Background()
	commit(t, w.a, "README", "from a\n", "a: edit")
	git(t, w.a, "push", "-q")
	commit(t, w.b, "README", "from b\n", "b: conflicting edit")

	// ff-only refuses; the push is rejected.
	wantFailed(t, mustOp(t)(w.m.Pull(ctx, PullOptions{WorktreePath: w.b})), "fast-forward")
	wantFailed(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.b})), "[rejected]")

	// A conflicting rebase is aborted, leaving b where it was.
	head := git(t, w.b, "rev-parse", "HEAD")
	op := mustOp(t)(w.m.Pull(ctx, PullOptions{WorktreePath: w.b, Rebase: true}))
	wantFailed(t, op, "aborted")
	if got := git(t, w.b, "rev-parse", "HEAD"); got != head {
		t.Errorf("HEAD moved to %s after an aborted rebase", got)
	}
	if st := git(t, w.b, "status", "--porcelain"); st != "" {
		t.Errorf("worktree dirty after abort: %q", st)
	}

	// force-with-lease overwrites origin (b has seen origin's tip since the fetch).
	op = mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.b, ForceWithLease: true}))
	wantOK(t, op, "force-pushed main to origin")
	if op.Title != "Force-push main" {
		t.Errorf("title = %q", op.Title)
	}

	// A non-conflicting rebase succeeds.
	commit(t, w.a, "other.txt", "x\n", "a: unrelated")
	wantFailed(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "[rejected]")
	wantOK(t, mustOp(t)(w.m.Pull(ctx, PullOptions{WorktreePath: w.a, Rebase: true})), "")
	wantOK(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "pushed main to origin")
}

func TestPushEdgeCases(t *testing.T) {
	w := newWorld(t, Options{})
	ctx := context.Background()
	git(t, w.a, "switch", "-q", "--detach")
	wantFailed(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.a})), "detached")

	git(t, w.b, "remote", "remove", "origin")
	wantFailed(t, mustOp(t)(w.m.Push(ctx, PushOptions{WorktreePath: w.b})), "no remote named origin")

	for _, p := range []string{"", "relative/path", filepath.Join(w.a, "missing"), filepath.Join(w.a, "README")} {
		if _, err := w.m.Fetch(ctx, FetchOptions{WorktreePath: p}); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Fetch(%q) err = %v, want ErrInvalidArgument", p, err)
		}
	}
	// Not a git repository: the op fails with git's message.
	wantFailed(t, mustOp(t)(w.m.Fetch(ctx, FetchOptions{WorktreePath: t.TempDir()})), "not a git repository")
}

func TestEventsAndSnapshot(t *testing.T) {
	gate := make(chan struct{})
	fr := &fakeRunner{block: map[string]chan struct{}{"fetch": gate}}
	w := newWorld(t, Options{Runner: fr})
	sub := bus.Subscribe[Event](w.bus, 16)
	defer sub.Close()
	ctx := context.Background()

	var wg sync.WaitGroup
	results := make([]Op, 2)
	wg.Go(func() { results[0], _ = w.m.Fetch(ctx, FetchOptions{WorktreePath: w.a}) })
	first := next(t, sub)
	if first.Type != Started || first.Op.Kind != KindFetch || first.Op.State != StateRunning {
		t.Fatalf("first event = %+v", first)
	}
	wg.Go(func() { results[1], _ = w.m.Push(ctx, PushOptions{WorktreePath: w.a}) })
	queued := next(t, sub)
	if queued.Type != Queued || queued.Op.Kind != KindPush {
		t.Fatalf("second event = %+v, want push queued behind fetch", queued)
	}
	snap := w.m.Snapshot()
	if len(snap.Ops) != 2 || snap.Ops[0].State != StateRunning || snap.Ops[1].State != StateQueued {
		t.Fatalf("snapshot while running = %+v", snap.Ops)
	}
	close(gate)
	var types []EventType
	var kinds []Kind
	for range 3 {
		ev := next(t, sub)
		types = append(types, ev.Type)
		kinds = append(kinds, ev.Op.Kind)
	}
	if !slices.Equal(types, []EventType{Finished, Started, Finished}) || !slices.Equal(kinds, []Kind{KindFetch, KindPush, KindPush}) {
		t.Errorf("events = %v %v, want fetch finished, push started, push finished", types, kinds)
	}
	wg.Wait()
	snap = w.m.Snapshot()
	if len(snap.Ops) != 2 || snap.Ops[0].ID != results[1].ID || snap.Ops[1].ID != results[0].ID {
		t.Errorf("finished snapshot = %+v, want push then fetch (newest first)", snap.Ops)
	}
}

func next(t *testing.T, sub *bus.Subscription[Event]) Event {
	t.Helper()
	select {
	case ev := <-sub.C():
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
		return Event{}
	}
}

func TestTimeoutAndClose(t *testing.T) {
	fr := &fakeRunner{block: map[string]chan struct{}{"fetch": make(chan struct{})}}
	w := newWorld(t, Options{Runner: fr, Timeouts: map[Kind]time.Duration{KindFetch: 50 * time.Millisecond}})
	op := mustOp(t)(w.m.Fetch(context.Background(), FetchOptions{WorktreePath: w.a}))
	wantFailed(t, op, "timed out after 50ms")

	// The caller giving up does not cancel the op; Close does.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	w.m.opts.Timeouts[KindFetch] = time.Hour
	if _, err := w.m.Fetch(ctx, FetchOptions{WorktreePath: w.a}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the caller's deadline", err)
	}
	if s := w.m.Snapshot(); len(s.Ops) == 0 || s.Ops[0].State != StateRunning {
		t.Fatalf("op should still run after the caller left: %+v", s.Ops)
	}
	_ = w.m.Close()
	if s := w.m.Snapshot(); s.Ops[0].State != StateFailed || !strings.Contains(s.Ops[0].Summary, "shutting down") {
		t.Errorf("after Close: %+v", s.Ops[0])
	}
	if _, err := w.m.Fetch(context.Background(), FetchOptions{WorktreePath: w.a}); !errors.Is(err, ErrClosed) {
		t.Errorf("Fetch after Close err = %v", err)
	}
}

func TestOutputCap(t *testing.T) {
	fr := &fakeRunner{reply: map[string]Result{"fetch": {Combined: strings.Repeat("x", MaxOutput*2)}}}
	w := newWorld(t, Options{Runner: fr})
	op := mustOp(t)(w.m.Fetch(context.Background(), FetchOptions{WorktreePath: w.a}))
	if len(op.Output) > MaxOutput+64 || !strings.HasPrefix(op.Output, "…(truncated)") {
		t.Errorf("output len %d, prefix %q", len(op.Output), op.Output[:20])
	}
}

func TestGitHubSlug(t *testing.T) {
	w := newWorld(t, Options{})
	sub := filepath.Join(w.a, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	tests := []struct{ repoID, path, want string }{
		{"", w.a, "me/a"},
		{"", sub, "me/a"},
		{"ra", "", "me/a"},
		{"", w.b, ""},
		{"nope", "", ""},
	}
	for _, tt := range tests {
		if got := w.m.GitHubSlug(tt.repoID, tt.path); got != tt.want {
			t.Errorf("GitHubSlug(%q, %q) = %q, want %q", tt.repoID, tt.path, got, tt.want)
		}
	}
}
