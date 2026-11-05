package project

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// eventLog records what CreateWorktreeOptions.Progress is told.
type eventLog struct {
	mu  sync.Mutex
	got []WorktreeEvent
}

func (l *eventLog) add(ev WorktreeEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.got = append(l.got, ev)
}

func (l *eventLog) kinds() []WorktreeEventKind {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]WorktreeEventKind, len(l.got))
	for i, ev := range l.got {
		out[i] = ev.Kind
	}
	return out
}

func (l *eventLog) ended() (WorktreeEvent, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	i := slices.IndexFunc(l.got, func(ev WorktreeEvent) bool { return ev.Kind == WorktreeFetchEnded })
	if i < 0 {
		return WorktreeEvent{}, false
	}
	return l.got[i], true
}

// FetchBase, then CreateWorktree without Fetch, resolves exactly what CreateWorktree with
// Fetch does: the rule stays in one place, startPoint.
func TestFetchBaseThenCreateWorktree(t *testing.T) {
	tests := []struct {
		name string
		// setup returns the options and the sha the worktree must be at.
		setup     func(t *testing.T, f fixture) (CreateWorktreeOptions, string)
		wantFetch int
		wantRef   string // the ref a fetch names
		// wantErr: the fetch failed; wantRefAt: the ref on disk has a time.
		wantErr, wantMissing bool
	}{
		{
			name: "the default branch comes from origin",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				return CreateWorktreeOptions{BaseFromOrigin: true}, pushCommit(t, f.other, "a")
			},
			wantFetch: 1, wantRef: "origin/main",
		},
		{
			name: "a bare base is origin's copy",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				return CreateWorktreeOptions{BaseRef: "main", BaseFromOrigin: true}, pushCommit(t, f.other, "a")
			},
			wantFetch: 1, wantRef: "origin/main",
		},
		{
			name: "a remote-tracking base is fetched and used as typed",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.other, "checkout", "-q", "-b", "dev")
				return CreateWorktreeOptions{BaseRef: "origin/dev", BaseFromOrigin: true}, pushCommit(t, f.other, "d")
			},
			wantFetch: 1, wantRef: "origin/dev",
		},
		{
			name: "a local branch ahead of origin's stays the base",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				writeFile(t, filepath.Join(f.project, "mine"), "mine\n")
				git(t, f.project, "add", "mine")
				git(t, f.project, "commit", "-q", "-m", "mine")
				return CreateWorktreeOptions{BaseFromOrigin: true}, git(t, f.project, "rev-parse", "HEAD")
			},
			wantFetch: 1, wantRef: "origin/main",
		},
		{
			name: "off: the local branch, nothing fetched",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				head := git(t, f.project, "rev-parse", "HEAD")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{}, head
			},
		},
		{
			name: "a tag is used as typed, nothing fetched",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.project, "tag", "v1")
				head := git(t, f.project, "rev-parse", "HEAD")
				pushCommit(t, f.other, "a")
				return CreateWorktreeOptions{BaseRef: "v1", BaseFromOrigin: true}, head
			},
		},
		{
			name: "unreachable: told, and the stale ref is the base",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				stale := git(t, f.project, "rev-parse", "origin/main")
				git(t, f.project, "remote", "set-url", "origin", filepath.Join(f.base, "gone.git"))
				return CreateWorktreeOptions{BaseFromOrigin: true}, stale
			},
			wantFetch: 1, wantRef: "origin/main", wantErr: true,
		},
		{
			name: "origin has no such branch: the local one, and no warning",
			setup: func(t *testing.T, f fixture) (CreateWorktreeOptions, string) {
				git(t, f.project, "branch", "only-here")
				return CreateWorktreeOptions{BaseRef: "only-here", BaseFromOrigin: true}, git(t, f.project, "rev-parse", "HEAD")
			},
			wantFetch: 1, wantRef: "origin/only-here", wantMissing: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixture(t)
			opts, wantHead := tt.setup(t, f)
			cr := &countingRunner{next: ExecRunner{}, n: map[string]int{}}
			h := startHarness(t, "", Options{Runner: cr, WorktreeRoot: filepath.Join(f.base, "wt"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
			ctx := context.Background()
			r, err := h.store.Register(ctx, f.project)
			if err != nil {
				t.Fatal(err)
			}
			var events eventLog
			opts.ProjectID, opts.Progress, opts.Fetch = r.ID, events.add, true
			before := cr.count("fetch")
			h.store.FetchBase(ctx, opts)
			if got := cr.count("fetch") - before; got != tt.wantFetch {
				t.Errorf("fetches = %d, want %d", got, tt.wantFetch)
			}
			ev, fetched := events.ended()
			if fetched != (tt.wantFetch > 0) {
				t.Fatalf("events %v", events.kinds())
			}
			if fetched {
				if ev.Ref != tt.wantRef || ev.Remote != "origin" || (ev.Err != nil) != tt.wantErr || ev.Missing != tt.wantMissing {
					t.Errorf("fetch ended %+v", ev)
				}
				if tt.wantErr && (ev.RefAt.IsZero() || GitText(ev.Err) == "" || strings.Contains(GitText(ev.Err), "exit 128")) {
					t.Errorf("a failed fetch says %q, ref at %v", GitText(ev.Err), ev.RefAt)
				}
			}
			opts.Branch, opts.Fetch = "cf/new", false
			before = cr.count("fetch")
			w, err := h.store.CreateWorktree(ctx, opts)
			if err != nil {
				t.Fatal(err)
			}
			if got := cr.count("fetch") - before; got != 0 {
				t.Errorf("CreateWorktree fetched %d times", got)
			}
			if w.Head != wantHead {
				t.Errorf("head = %s, want %s", w.Head, wantHead)
			}
			if k := events.kinds(); k[len(k)-1] != WorktreeAdding {
				t.Errorf("events %v", k)
			}
		})
	}
}

func TestCreateWorktreeToldItsOwnFetch(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	var events eventLog
	if _, err := h.store.CreateWorktree(ctx, CreateWorktreeOptions{ProjectID: r.ID, Branch: "cf/x", Fetch: true, BaseFromOrigin: true, Progress: events.add}); err != nil {
		t.Fatal(err)
	}
	want := []WorktreeEventKind{WorktreeFetchStarted, WorktreeFetchEnded, WorktreeAdding}
	if got := events.kinds(); !slices.Equal(got, want) {
		t.Errorf("events %v, want %v", got, want)
	}
}

func TestFetchBaseUnknownProject(t *testing.T) {
	f := newFixture(t)
	h := startHarness(t, "", Options{WorktreeRoot: filepath.Join(f.base, "wt"), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	var events eventLog
	h.store.FetchBase(context.Background(), CreateWorktreeOptions{ProjectID: "nope", BaseFromOrigin: true, Progress: events.add})
	if got := events.kinds(); len(got) != 0 {
		t.Errorf("events %v", got)
	}
}

func TestGitText(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"git's stderr", &GitError{Stderr: "  fatal: no\n", Args: []string{"worktree"}, ExitCode: 128}, "fatal: no"},
		{"wrapped", wrapped{&GitError{Stderr: "fatal: no"}}, "fatal: no"},
		{"not git's", errNotGit, "not git"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := GitText(tt.err); got != tt.want {
				t.Errorf("GitText = %q", got)
			}
		})
	}
}

var errNotGit = plainError("not git")

type plainError string

func (e plainError) Error() string { return string(e) }

type wrapped struct{ err error }

func (w wrapped) Error() string { return "outer: " + w.err.Error() }
func (w wrapped) Unwrap() error { return w.err }
