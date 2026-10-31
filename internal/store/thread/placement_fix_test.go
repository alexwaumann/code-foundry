package thread

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The fixes from the workspaces v2 fuzz round, area A (docs/notes/workspaces-v2-fix-2-threads.md).

// branchRefs is a RefExists over the fake project store: a local branch exists while one
// of the project's worktrees has it checked out, so a branch another Create made shows.
func branchRefs(rr *recordingProjects) func(context.Context, string, string) bool {
	return func(_ context.Context, dir, ref string) bool {
		b, ok := strings.CutPrefix(ref, "refs/heads/")
		if !ok {
			return false
		}
		for _, r := range rr.Snapshot().Projects {
			if samePath(r.Path, dir) && slices.ContainsFunc(r.Worktrees, func(w project.Worktree) bool { return w.Branch == b }) {
				return true
			}
		}
		return false
	}
}

// Finding A2: two Creates at the same time on the same new --branch share one worktree
// per project instead of the second failing on the first's; two whose auto-named
// branch is alike get branch and branch-2.
func TestParallelCreatesOnANewBranch(t *testing.T) {
	tests := []struct {
		name string
		o    CreateOptions
		// shared: both threads end in one worktree per project; else two branches.
		shared bool
	}{
		{name: "the same --branch is shared", o: CreateOptions{ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/dbl"}}, shared: true},
		{name: "the same --branch, one project", o: CreateOptions{ProjectID: "r1", NewWorktree: &NewWorktree{Branch: "feat/one"}}, shared: true},
		{name: "the same name in prefix mode gets -2", o: CreateOptions{ProjectIDs: []string{"r1", "r2"}, Name: "samename", NewWorktree: &NewWorktree{}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := multiEnv(t, func(o *Options) {
				p := o.Projects.(*recordingProjects)
				p.MakeDirs = true
				o.RefExists = branchRefs(p)
				o.FetchBranch = func(context.Context, string, string) bool { return false }
				o.BranchNaming = func() BranchNaming { return BranchNaming{Mode: BranchModePrefix, Prefix: "cf"} }
			})
			e.namer = func(string) (string, error) { return "", fmt.Errorf("%w in settings", ErrNamingOff) }
			var (
				wg      sync.WaitGroup
				threads [2]Thread
				reports [2]CreateReport
				errs    [2]error
			)
			for i := range 2 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					o := tt.o
					o.Report = &reports[i]
					threads[i], errs[i] = e.m.Create(e.ctx(), o)
				}()
			}
			wg.Wait()
			for i, err := range errs {
				if err != nil {
					t.Fatalf("create %d: %v", i, err)
				}
			}
			a, b := threads[0], threads[1]
			members := len(a.Projects())
			created := rr.created()
			if tt.shared {
				if a.Branch != b.Branch || a.WorktreePath != b.WorktreePath || len(created) != members {
					t.Fatalf("threads %+v and %+v, CreateWorktree calls %+v; want one shared worktree per project", a, b, created)
				}
				if reports[0].MadeWorktree == reports[1].MadeWorktree || reports[0].ExistingWorktree == reports[1].ExistingWorktree {
					t.Errorf("reports %+v, want one made and one existing", reports)
				}
				for i, r := range reports {
					if r.ExistingWorktree && r.SharedWith != holderLabel(threads[1-i]) {
						t.Errorf("report %d shares with %q, want %q", i, r.SharedWith, holderLabel(threads[1-i]))
					}
				}
				return
			}
			got := []string{a.Branch, b.Branch}
			slices.Sort(got)
			if !slices.Equal(got, []string{"cf/samename", "cf/samename-2"}) || len(created) != 2*members {
				t.Fatalf("branches %q, CreateWorktree calls %d; want cf/samename and cf/samename-2, %d calls", got, len(created), 2*members)
			}
		})
	}
}

// Finding A5: an explicit --branch that is only on origin (not fetched yet) is fetched
// and checked out tracking it, in every project, never made anew from the base.
func TestCreateFetchesANamedBranch(t *testing.T) {
	refs := &recreateRefs{}
	refs.set(nil, []string{"refs/remotes/origin/feat/ro"})
	e, rr := multiEnv(t, func(o *Options) { o.RefExists, o.FetchBranch = refs.exists, refs.fetch })
	s := e.create(CreateOptions{ProjectIDs: []string{"r1", "r2"}, Name: "ro", NewWorktree: &NewWorktree{Branch: "feat/ro", BaseRef: "origin/dev"}})
	if s.Branch != "feat/ro" {
		t.Fatalf("branch %q", s.Branch)
	}
	if !slices.Contains(refs.fetched, "feat/ro") {
		t.Errorf("fetched %q, want feat/ro", refs.fetched)
	}
	for _, c := range rr.created() {
		if c.BaseRef != "" {
			t.Errorf("CreateWorktree %+v: a base makes a new branch beside origin's", c)
		}
	}
}

// Finding A7: a member's main checkout on the thread's branch is never its worktree, and
// no second worktree is made on that branch: the Create is refused, naming the project,
// the branch and the checkout, before anything is made. A hand-made linked worktree on
// the branch is still reused, and checkout mode runs in the main checkout as asked.
func TestMainCheckoutOnTheBranch(t *testing.T) {
	tests := []struct {
		name string
		// linked: api also has a hand-made linked worktree on feat/mc.
		linked       bool
		checkoutMode bool
		wantErr      bool
	}{
		{name: "refused", wantErr: true},
		{name: "a hand-made linked worktree on the branch is reused", linked: true},
		{name: "checkout mode runs in it", checkoutMode: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := multiEnv(t, func(o *Options) {
				o.Projects.(*recordingProjects).MakeDirs = true
				// The branch exists: the main checkout has it.
				o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/mc" }
			})
			api, _ := rr.Snapshot().Project("r2")
			api.Worktrees = []project.Worktree{{ProjectID: "r2", Path: api.Path, IsMain: true, Branch: "feat/mc"}}
			hand := filepath.Join(t.TempDir(), "api-mc")
			if tt.linked {
				if err := os.MkdirAll(hand, 0o755); err != nil {
					t.Fatal(err)
				}
				api.Worktrees = append(api.Worktrees, project.Worktree{ProjectID: "r2", Path: hand, Branch: "feat/mc"})
			}
			rr.Put(api)
			o := CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, Name: "mc", NewWorktree: &NewWorktree{Branch: "feat/mc"}}
			if tt.checkoutMode {
				o.NewWorktree, o.CheckoutMode = nil, true
			}
			var report CreateReport
			o.Report = &report
			s, err := e.m.Create(e.ctx(), o)
			if tt.wantErr {
				want := "api's main checkout at " + api.Path + " is on feat/mc; switch it to another branch, or start the thread in place (--new-worktree=false)"
				if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), want) {
					t.Fatalf("err = %v, want one saying %q", err, want)
				}
				if n := len(rr.created()); n != 0 || len(e.m.Snapshot().Threads) != 0 {
					t.Errorf("%d CreateWorktree calls and %d threads after the refusal, want none", n, len(e.m.Snapshot().Threads))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case tt.linked:
				if !samePath(s.WorktreePath, hand) || !report.ExistingWorktree || slices.ContainsFunc(rr.created(), func(c project.CreateWorktreeOptions) bool { return c.ProjectID == "r2" }) {
					t.Errorf("thread in %s (report %+v, creates %+v), want the hand-made %s reused", s.WorktreePath, report, rr.created(), hand)
				}
			case tt.checkoutMode:
				if !samePath(s.WorktreePath, api.Path) || s.CreatedWorktree {
					t.Errorf("thread %+v, want checkout mode in %s", s, api.Path)
				}
			}
		})
	}
}

// Finding A6: a remade member whose branch was gone says so, as the primary's note does.
func TestRemadeNote(t *testing.T) {
	tests := []struct {
		name string
		made []madeWorktree
		want []string
		not  []string
	}{
		{name: "the branch was there", made: []madeWorktree{{projectID: "r2", projectName: "api", path: "/wt/api/feat-x"}},
			want: []string{"The worktree of another project of this thread was removed and has been recreated from branch feat/x (/wt/api/feat-x)"},
			not:  []string{"no longer existed"}},
		{name: "the branch was gone", made: []madeWorktree{{projectID: "r2", projectName: "api", path: "/wt/api/feat-x", newBranch: true, startPoint: "origin/main"}},
			want: []string{"The worktree of project api (/wt/api/feat-x) was removed and branch feat/x no longer existed there, so both were recreated from origin/main",
				"only if they reached origin/main"},
			not: []string{"another project"}},
		{name: "one of each", made: []madeWorktree{
			{projectID: "r1", projectName: "web", path: "/wt/web/feat-x"},
			{projectID: "r2", projectName: "api", path: "/wt/api/feat-x", newBranch: true, startPoint: "origin/main"}},
			want: []string{"another project of this thread was removed and has been recreated from branch feat/x (/wt/web/feat-x)", "project api (/wt/api/feat-x)"}},
		{name: "made again on its last head", made: []madeWorktree{
			{projectID: "r1", projectName: "web", path: "/wt/web/feat-x", branch: "feat/y"},
			{projectID: "r2", projectName: "api", path: "/wt/api/feat-x", branch: "feat/x"}},
			want: []string{"has been recreated from branch feat/y, where this thread had moved from feat/x (/wt/web/feat-x).",
				"has been recreated from branch feat/x (/wt/api/feat-x)."}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := remadeNote(tt.made, "feat/x")
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("note %q lacks %q", got, w)
				}
			}
			for _, n := range tt.not {
				if strings.Contains(got, n) {
					t.Errorf("note %q has %q", got, n)
				}
			}
		})
	}
}

// Finding A10: a fork that makes a removed member worktree again notes it in its
// timeline and runs the project's on-worktree-create actions, as a start does.
func TestForkRemakesMemberWithNoteAndHook(t *testing.T) {
	hook := &createdHook{}
	e, rr := multiEnv(t, func(o *Options) {
		o.Projects.(*recordingProjects).MakeDirs = true
		o.WorktreeCreated = hook.record
		// The branch stays when its worktree is removed.
		o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/f" }
	})
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, InitialPrompt: "first", NewWorktree: &NewWorktree{Branch: "feat/f"}})
	e.waitItems(s.ID, "the first turn", turnCount(1))
	cid := argOf(e.spec(s.ID).Argv, "--session-id")
	e.writeTranscriptIn(s.WorktreePath, cid, userLine("hi"))
	e.waitFor(s.ID, "discovered", func(s Thread) bool { return s.ClaudeSessionID == cid })
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	repoWT := tc.Checkouts[0].Path
	if err := os.RemoveAll(repoWT); err != nil {
		t.Fatal(err)
	}
	r, _ := rr.Snapshot().Project("r1")
	r.Worktrees = slices.DeleteFunc(slices.Clone(r.Worktrees), func(w project.Worktree) bool { return w.Path == repoWT })
	rr.Put(r)
	f, err := e.m.Fork(e.ctx(), s.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if !isDir(repoWT) {
		t.Fatalf("the removed member worktree %s was not made again", repoWT)
	}
	e.waitItems(f.ID, "the recreate note", func(items []Item) bool {
		return slices.ContainsFunc(items, func(it Item) bool {
			return it.Kind == KindNote && strings.Contains(it.Text, "has been recreated from branch feat/f ("+filepath.Clean(repoWT)+")")
		})
	})
	if !slices.Contains(hook.got(), f.ID+" r1 "+filepath.Clean(repoWT)) {
		t.Errorf("worktree-created calls %q, want the fork's for r1", hook.got())
	}
}

// Finding A10: a member whose project was unregistered is left out of a start with one
// timeline note, not one per start.
func TestUnregisteredMemberNotedOnce(t *testing.T) {
	e, rr := multiEnv(t)
	s := e.connected(CreateOptions{ProjectID: "r1", ProjectIDs: []string{"r1", "r2"}})
	if err := rr.Unregister(e.ctx(), "r2"); err != nil {
		t.Fatal(err)
	}
	count := func(items []Item) int {
		n := 0
		for _, it := range items {
			if it.ID == unregisteredNoteID("r2") {
				n++
			}
		}
		return n
	}
	for range 2 {
		if err := e.m.Close(e.ctx(), s.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
			t.Fatal(err)
		}
		e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
	}
	if n := count(e.items(s.ID).Items); n != 1 {
		t.Errorf("%d notes about the unregistered project, want 1", n)
	}
}
