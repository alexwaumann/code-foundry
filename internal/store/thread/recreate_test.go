package thread

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// recreateRefs is a mutable ref set for RefExists and FetchBranch.
type recreateRefs struct {
	mu      sync.Mutex
	refs    []string
	onFetch []string // refs a fetch of the branch finds on origin
	fetched []string // branches fetched
}

func (r *recreateRefs) set(refs, onFetch []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refs, r.onFetch = refs, onFetch
}

func (r *recreateRefs) exists(_ context.Context, _, ref string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.refs, ref)
}

func (r *recreateRefs) fetch(_ context.Context, _, branch string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fetched = append(r.fetched, branch)
	return slices.Contains(r.onFetch, "refs/remotes/origin/"+branch)
}

// createdHook records WorktreeCreated calls.
type createdHook struct {
	mu    sync.Mutex
	calls []string
}

func (h *createdHook) record(threadID, projectID, worktree string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, threadID+" "+projectID+" "+worktree)
}

func (h *createdHook) got() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.calls)
}

// A thread whose worktree a cleanup removed gets it back, at the same path, when a
// message starts it: on the local branch, origin's, or (both gone) a new one from the
// recorded base. The conversation resumes; the timeline says what happened; the
// on-worktree-create hook runs again. Anything outside the rule keeps the refusal.
func TestSendRecreatesRemovedWorktree(t *testing.T) {
	tests := []struct {
		name string
		base string // CreateOptions.NewWorktree.BaseRef
		// refs RefExists reports at the send ("<b>" is the thread's branch); onFetch are
		// what a fetch of the branch finds.
		refs, onFetch []string
		// prepare changes the setup before the send (row fields, the project).
		prepare func(e *env, rr *recreatingEnv, s Thread)
		// wantBase is the CreateWorktree BaseRef of the recreation; wantNote a part of
		// its note.
		wantBase, wantNote string
		wantFetch          bool
		// wantErr: the start fails with this in the error item; nothing is recreated
		// when wantNoCreate.
		wantErr      string
		wantNoCreate bool
	}{
		{name: "local branch", refs: []string{"refs/heads/<b>"}, wantNote: "recreated from branch <b>. Untracked and ignored files"},
		{name: "only on origin", refs: []string{"refs/remotes/origin/<b>"}, wantNote: "recreated from branch <b>."},
		{name: "on origin after a fetch", onFetch: []string{"refs/remotes/origin/<b>"}, wantFetch: true,
			wantNote: "recreated from branch <b>."},
		{name: "branch gone: from the recorded base", base: "origin/release", wantFetch: true, wantBase: "origin/release",
			wantNote: "branch <b> no longer existed, so both were recreated from origin/release. Commits made on the branch earlier are on it only if they reached origin/release"},
		{name: "branch gone, no recorded base: the default", wantFetch: true,
			prepare: func(e *env, _ *recreatingEnv, s Thread) {
				e.m.update(s.ID, true, func(r *record) { r.s.BaseRef = "" })
			},
			wantNote: "recreated from origin/main."},
		{name: "a different path is refused", refs: []string{"refs/heads/<b>"},
			prepare: func(e *env, _ *recreatingEnv, _ Thread) {
				r, _ := e.projects.Snapshot().Project("r1")
				r.Name = "renamed"
				e.projects.Put(r)
			},
			wantErr: "not at the thread's"},
		{name: "a workspace thread keeps the refusal", refs: []string{"refs/heads/<b>"},
			prepare: func(e *env, _ *recreatingEnv, s Thread) {
				e.m.update(s.ID, true, func(r *record) { r.s.WorkspaceID = "w1" })
			},
			wantErr: "Claude did not start: failed precondition: worktree ", wantNoCreate: true},
		{name: "a row without a branch keeps the refusal", refs: []string{"refs/heads/<b>"},
			prepare: func(e *env, _ *recreatingEnv, s Thread) {
				e.m.update(s.ID, true, func(r *record) { r.s.Branch = "" })
			},
			wantErr: "Claude did not start: failed precondition: worktree ", wantNoCreate: true},
		{name: "a worktree outside the worktrees root keeps the refusal", refs: []string{"refs/heads/<b>"},
			prepare: func(e *env, _ *recreatingEnv, _ Thread) { e.m.opts.WorktreeRoot = t.TempDir() },
			wantErr: "Claude did not start: failed precondition: worktree ", wantNoCreate: true},
		{name: "a project that is gone is refused", refs: []string{"refs/heads/<b>"},
			prepare: func(e *env, _ *recreatingEnv, _ Thread) {
				if err := e.projects.Unregister(context.Background(), "r1"); err != nil {
					t.Fatal(err)
				}
			},
			wantErr: "its project r1 is no longer registered", wantNoCreate: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, re := newRecreatingEnv(t)
			s := e.create(CreateOptions{ProjectID: "r1", InitialPrompt: "first", NewWorktree: &NewWorktree{BaseRef: tt.base}})
			e.waitItems(s.ID, "the first turn", turnCount(1))
			b := s.Branch
			if b == "" || s.WorktreePath == "" || !s.CreatedWorktree {
				t.Fatalf("created %+v", s)
			}
			cid := argOf(e.spec(s.ID).Argv, "--session-id")
			e.writeTranscriptIn(s.WorktreePath, cid, userLine("hi"))
			e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
			if err := e.m.Close(e.ctx(), s.ID); err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(s.WorktreePath); err != nil {
				t.Fatal(err)
			}
			sub := func(refs []string) []string {
				out := make([]string, len(refs))
				for i, r := range refs {
					out[i] = strings.ReplaceAll(r, "<b>", b)
				}
				return out
			}
			re.refs.set(sub(tt.refs), sub(tt.onFetch))
			if tt.prepare != nil {
				tt.prepare(e, re, s)
			}
			creates := len(re.projects.created())

			if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
				t.Fatal(err)
			}
			if tt.wantErr != "" {
				got := e.waitFor(s.ID, "the failed start", func(s Thread) bool { return stopped(s) && s.Status == StatusError })
				items := e.items(s.ID).Items
				i := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindError })
				if i < 0 || !strings.Contains(items[i].Text, tt.wantErr) || !strings.Contains(got.LastError, tt.wantErr) {
					t.Errorf("want an error with %q; LastError %q\n%s", tt.wantErr, got.LastError, describeItems(items))
				}
				if n := len(re.projects.created()); tt.wantNoCreate && n != creates {
					t.Errorf("%d worktrees created for a refused start", n-creates)
				}
				if n := kindCount(items, KindNote); n != 0 {
					t.Errorf("%d notes for a refused start", n)
				}
				if calls := re.hook.got(); len(calls) != 1 {
					t.Errorf("worktree-created calls %q, want only Create's", calls)
				}
				return
			}

			e.waitDeliveries("again", func(f, r int) bool { return r == 1 })
			got := e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
			if got.WorktreePath != s.WorktreePath || got.Branch != b || got.LastError != "" {
				t.Errorf("after the start %+v", got)
			}
			if _, err := os.Stat(s.WorktreePath); err != nil {
				t.Errorf("worktree not recreated: %v", err)
			}
			if argv := e.argvOf(); argOf(argv, "--resume") != cid {
				t.Errorf("argv %q, want --resume %s", argv, cid)
			}
			all := re.projects.created()
			if len(all) != creates+1 {
				t.Fatalf("CreateWorktree calls %+v", all)
			}
			want := project.CreateWorktreeOptions{ProjectID: "r1", Branch: b, BaseRef: tt.wantBase, Fetch: true, BaseFromOrigin: true}
			if all[creates] != want {
				t.Errorf("recreated with %+v, want %+v", all[creates], want)
			}
			if fetched := slices.Contains(re.refs.fetched, b); fetched != tt.wantFetch {
				t.Errorf("fetched %q, want a fetch of the branch %v", re.refs.fetched, tt.wantFetch)
			}
			items := e.items(s.ID).Items
			n := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindNote })
			u := slices.IndexFunc(items, func(it Item) bool { return it.Kind == KindUserMessage && it.Text == "again" })
			wantNote := strings.ReplaceAll(tt.wantNote, "<b>", b)
			if n < 0 || u != n+1 || !strings.Contains(items[n].Text, wantNote) {
				t.Errorf("want the note %q before the message\n%s", wantNote, describeItems(items))
			}
			wantHook := []string{s.ID + " r1 " + s.WorktreePath, s.ID + " r1 " + s.WorktreePath}
			if calls := re.hook.got(); !slices.Equal(calls, wantHook) {
				t.Errorf("worktree-created calls %q, want %q", calls, wantHook)
			}
		})
	}
}

// A start without a message (Reconnect, running) recreates too, and still notes it.
func TestReconnectRecreatesRemovedWorktree(t *testing.T) {
	e, re := newRecreatingEnv(t)
	s := e.create(CreateOptions{ProjectID: "r1", InitialPrompt: "first", NewWorktree: &NewWorktree{}})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(s.WorktreePath); err != nil {
		t.Fatal(err)
	}
	re.refs.set([]string{"refs/heads/" + s.Branch}, nil)
	if _, err := e.m.Reconnect(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
	items := e.items(s.ID).Items
	if !slices.ContainsFunc(items, func(it Item) bool {
		return it.Kind == KindNote && strings.Contains(it.Text, "recreated from branch "+s.Branch)
	}) {
		t.Errorf("no recreation note\n%s", describeItems(items))
	}
	if calls := re.hook.got(); len(calls) != 2 {
		t.Errorf("worktree-created calls %q", calls)
	}
}

// Fork copies what the parent's worktree was made for.
func TestForkCopiesWorktreeOrigin(t *testing.T) {
	e, _ := newRecreatingEnv(t)
	s := e.create(CreateOptions{ProjectID: "r1", InitialPrompt: "first", NewWorktree: &NewWorktree{BaseRef: "origin/release"}})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscriptIn(s.WorktreePath, cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if f.Branch != s.Branch || f.BaseRef != "origin/release" || !f.CreatedWorktree || f.WorktreePath != s.WorktreePath {
		t.Errorf("fork %+v of %+v", f, s)
	}
}

// recreatingEnv is newWorktreeEnv with mutable refs, the worktree root set and the
// worktree-created hook recorded.
type recreatingEnv struct {
	projects *recordingProjects
	refs     *recreateRefs
	hook     *createdHook
}

func newRecreatingEnv(t *testing.T) (*env, *recreatingEnv) {
	t.Helper()
	re := &recreatingEnv{refs: &recreateRefs{}, hook: &createdHook{}}
	e, rr := newWorktreeEnv(t, nil, func(o *Options) {
		o.RefExists, o.FetchBranch, o.WorktreeCreated = re.refs.exists, re.refs.fetch, re.hook.record
		o.WorktreeRoot = o.Projects.(*recordingProjects).WorktreeRoot
	})
	re.projects = rr
	return e, re
}

// Rows from before the branch column get it from their worktree once their project
// listed worktrees; the others are left without one.
func TestBackfillBranch(t *testing.T) {
	snap := &project.Snapshot{Projects: []project.Project{
		{ID: "r1", Worktrees: []project.Worktree{
			{ProjectID: "r1", Path: "/w/main", IsMain: true, Branch: "main"},
			{ProjectID: "r1", Path: "/w/a", Branch: "cf/a"},
			{ProjectID: "r1", Path: "/w/d", Detached: true},
		}},
		{ID: "r2"}, // not reconciled yet
	}}
	tests := []struct {
		name        string
		s           Thread
		wantBranch  string
		wantDecided bool
	}{
		{"its worktree's branch", Thread{ProjectID: "r1", WorktreePath: "/w/a"}, "cf/a", true},
		{"worktree gone", Thread{ProjectID: "r1", WorktreePath: "/w/gone"}, "", true},
		{"detached", Thread{ProjectID: "r1", WorktreePath: "/w/d"}, "", true},
		{"project gone", Thread{ProjectID: "r9", WorktreePath: "/w/a"}, "", true},
		{"project without worktrees yet", Thread{ProjectID: "r2", WorktreePath: "/w/b"}, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, decided := backfillBranch(snap, tt.s)
			if b != tt.wantBranch || decided != tt.wantDecided {
				t.Errorf("backfillBranch = %q, %v; want %q, %v", b, decided, tt.wantBranch, tt.wantDecided)
			}
		})
	}
}

// At startup a row the app made the worktree of, without a branch, gets its worktree's
// branch, persisted.
func TestBackfillBranchesAtStartup(t *testing.T) {
	e := newEnv(t)
	wt := filepath.Join(t.TempDir(), "wt")
	if err := os.MkdirAll(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	r, _ := e.projects.Snapshot().Project("r1")
	r.Worktrees = append(slices.Clone(r.Worktrees), project.Worktree{ProjectID: "r1", Path: wt, Branch: "cf/old"})
	e.projects.Put(r)
	s := e.connected(CreateOptions{ProjectID: "r1", WorktreePath: wt})
	other := e.connected(CreateOptions{})
	for _, id := range []string{s.ID, other.ID} {
		e.m.update(id, true, func(r *record) { r.s.CreatedWorktree = true })
	}
	e.restart()
	e.waitFor(s.ID, "the branch filled in", func(s Thread) bool { return s.Branch == "cf/old" })
	if got := e.snapshot(other.ID); got.Branch != "" {
		t.Errorf("main checkout's thread got branch %q", got.Branch)
	}
	e.restart()
	if got := e.snapshot(s.ID); got.Branch != "cf/old" {
		t.Errorf("after another restart branch %q (not persisted?)", got.Branch)
	}
}
