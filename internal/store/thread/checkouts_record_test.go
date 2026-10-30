package thread

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// mkWorktree lists a hand-made worktree of project id at a new directory, on branch.
func mkWorktree(t *testing.T, rr *recordingProjects, id, branch string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), strings.ReplaceAll(branch, "/", "-"))
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	r, _ := rr.Snapshot().Project(id)
	r.Worktrees = append(slices.Clone(r.Worktrees), project.Worktree{ProjectID: id, Path: path, Branch: branch})
	rr.Put(r)
	return path
}

// switchBranch is `git switch` in the worktree at path: the project store lists it on
// branch now ("" detaches it).
func switchBranch(rr *recordingProjects, id, path, branch string) {
	rr.UpdateWorktree(project.Worktree{ProjectID: id, Path: path, Branch: branch, Detached: branch == ""})
}

// checkoutOf is s's checkout of project id.
func checkoutOf(t *testing.T, e *env, id, projectID string) Checkout {
	t.Helper()
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: id})
	if err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(tc.Checkouts, func(c Checkout) bool { return c.ProjectID == projectID })
	if i < 0 {
		t.Fatalf("thread %s has no checkout of %s: %+v", id, projectID, tc.Checkouts)
	}
	return tc.Checkouts[i]
}

// A worktree-mode thread records every member's worktree at Create, and keeps it when
// its branch moves: a hand-made worktree switched to another branch is still the
// thread's (the derivation by branch lost it and took whatever was on the branch), a
// start does not make another, and a thread in the worktree that took the branch does
// not collide with it while one at the moved checkout does.
func TestCheckoutsSurviveABranchMove(t *testing.T) {
	e, rr := multiEnv(t, func(o *Options) {
		o.Projects.(*recordingProjects).MakeDirs = true
		o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/x" }
	})
	px := mkWorktree(t, rr, "r1", "feat/x") // a member's own worktree on the branch, made by hand
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/x"}})
	if got := s.CheckoutPaths; got["r1"] != px || got["r2"] != s.WorktreePath || len(got) != 2 {
		t.Fatalf("recorded %v, want r1 at %s and r2 at the cwd %s", got, px, s.WorktreePath)
	}
	if got := rr.created(); len(got) != 1 || got[0].ProjectID != "r2" {
		t.Fatalf("CreateWorktree calls %+v, want only r2's (r1's is reused)", got)
	}

	// git switch -c other in it, and another worktree takes feat/x.
	switchBranch(rr, "r1", px, "other")
	pb := mkWorktree(t, rr, "r1", "feat/x2")
	switchBranch(rr, "r1", pb, "feat/x")
	c := checkoutOf(t, e, s.ID, "r1")
	if c.Path != px || c.Branch != "other" || !c.Moved || c.CreatedBranch != "feat/x" || !c.WorktreeMode || c.Missing {
		t.Errorf("moved checkout %+v, want %s on other, moved from feat/x", c, px)
	}
	if p := checkoutOf(t, e, s.ID, "r2"); p.Branch != "feat/x" || p.Moved || !p.Primary {
		t.Errorf("primary %+v", p)
	}

	// Collision is the same path, not the same branch.
	onBranch := e.create(CreateOptions{ProjectID: "r1", WorktreePath: pb})
	if hints := e.m.CheckoutHints(onBranch); len(hints) != 0 {
		t.Errorf("a thread in the worktree that took feat/x: hints %q, want none", hints)
	}
	atMoved := e.create(CreateOptions{ProjectID: "r1", WorktreePath: px})
	if hints := e.m.CheckoutHints(atMoved); len(hints) != 1 || !strings.Contains(hints[0], "repo @ other is also open in") {
		t.Errorf("a thread in the moved worktree: hints %q, want repo @ other", hints)
	}

	// The next start passes the moved worktree, and makes nothing.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
	if dirs := addDirs(e.spec(s.ID).Argv); !slices.Contains(dirs, px) || slices.Contains(dirs, pb) {
		t.Errorf("add-dirs %q, want the moved worktree %s", dirs, px)
	}
	if got := rr.created(); len(got) != 1 {
		t.Errorf("CreateWorktree calls after the start %+v, want none more", got)
	}

	// A child placed like it shares the checkouts as they are, branch moved or not.
	child := e.create(CreateOptions{Like: s.ID, ProjectID: "api"})
	if child.CheckoutPaths["r1"] != px || child.WorktreePath != s.WorktreePath || child.Branch != "feat/x" {
		t.Errorf("like child %+v, want the same checkouts", child)
	}
}

// A member whose worktree is gone is made again on the branch it was created for and
// recorded; a row with nothing recorded gets its checkouts recorded at the start.
func TestStartRecordsCheckouts(t *testing.T) {
	e, rr := multiEnv(t, func(o *Options) { o.Projects.(*recordingProjects).MakeDirs = true })
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/y"}})
	repoWT := s.CheckoutPaths["r1"]
	if repoWT == "" {
		t.Fatalf("recorded %v", s.CheckoutPaths)
	}
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	// Removed by a cleanup, and the row forgets what it recorded (a row from before).
	if err := os.RemoveAll(repoWT); err != nil {
		t.Fatal(err)
	}
	r, _ := rr.Snapshot().Project("r1")
	r.Worktrees = slices.DeleteFunc(slices.Clone(r.Worktrees), func(w project.Worktree) bool { return w.Path == repoWT })
	rr.Put(r)
	e.m.update(s.ID, true, func(r *record) { r.s.CheckoutPaths = nil })
	if c := checkoutOf(t, e, s.ID, "r1"); c.Recorded || !c.Missing || c.Path != repoWT {
		t.Fatalf("unrecorded missing member %+v, want resolved to %s, missing", c, repoWT)
	}
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
	if !isDir(repoWT) || got.CheckoutPaths["r1"] != repoWT || got.CheckoutPaths["r2"] != got.WorktreePath {
		t.Errorf("after the start: %v (made %v), want r1 made again at %s and both recorded", got.CheckoutPaths, isDir(repoWT), repoWT)
	}
	e.restart()
	if got := e.snapshot(s.ID); got.CheckoutPaths["r1"] != repoWT {
		t.Errorf("after a restart %v (not persisted?)", got.CheckoutPaths)
	}
}

// Run in keeps the checkout the thread leaves: a user's worktree a checkout-mode thread
// ran in is still its checkout of that project (the derivation said the main checkout).
func TestRunInKeepsTheCheckoutItLeaves(t *testing.T) {
	e, rr := multiEnv(t)
	mine := mkWorktree(t, rr, "r1", "mine")
	s := e.create(CreateOptions{ProjectID: "r1", WorktreePath: mine, ProjectIDs: []string{"r1", "r2"}})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	moved, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "api"})
	if err != nil {
		t.Fatal(err)
	}
	api, _ := rr.Snapshot().Project("r2")
	if moved.ProjectID != "r2" || moved.WorktreePath != api.Path || moved.CheckoutPaths["r1"] != mine || moved.CheckoutPaths["r2"] != api.Path {
		t.Fatalf("moved %+v", moved)
	}
	if c := checkoutOf(t, e, s.ID, "r1"); c.Path != mine || c.Primary {
		t.Errorf("left checkout %+v, want %s", c, mine)
	}
	back, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "repo"})
	if err != nil || back.WorktreePath != mine {
		t.Errorf("back = %+v, %v; want the worktree it left", back, err)
	}
}

// At startup a row from before migration 0049 gets its checkouts recorded from the
// derivation, persisted: a missing member worktree as "".
func TestFillCheckoutsAtStartup(t *testing.T) {
	e, rr := multiEnv(t, func(o *Options) { o.Projects.(*recordingProjects).MakeDirs = true })
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/z"}})
	gone := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/gone"}})
	none := e.create(CreateOptions{NoProject: true})
	for _, id := range []string{s.ID, gone.ID} {
		e.m.update(id, true, func(r *record) { r.s.CheckoutPaths = nil })
	}
	goneWT := gone.CheckoutPaths["r1"]
	if err := os.RemoveAll(goneWT); err != nil {
		t.Fatal(err)
	}
	r, _ := rr.Snapshot().Project("r1")
	r.Worktrees = slices.DeleteFunc(slices.Clone(r.Worktrees), func(w project.Worktree) bool { return w.Path == goneWT })
	rr.Put(r)
	e.restart()
	got := e.waitFor(s.ID, "checkouts filled", func(t Thread) bool { return t.CheckoutPaths != nil })
	if got.CheckoutPaths["r1"] != s.CheckoutPaths["r1"] || got.CheckoutPaths["r2"] != s.WorktreePath {
		t.Errorf("filled %v, want %v", got.CheckoutPaths, s.CheckoutPaths)
	}
	g := e.waitFor(gone.ID, "checkouts filled", func(t Thread) bool { return t.CheckoutPaths != nil })
	if p, ok := g.CheckoutPaths["r1"]; !ok || p != "" || g.CheckoutPaths["r2"] != gone.WorktreePath {
		t.Errorf("filled %v, want r1 empty (missing) and r2 the cwd", g.CheckoutPaths)
	}
	if n := e.snapshot(none.ID); n.CheckoutPaths != nil {
		t.Errorf("a thread without a project got %v", n.CheckoutPaths)
	}
	e.restart()
	if got := e.snapshot(s.ID); got.CheckoutPaths["r1"] != s.CheckoutPaths["r1"] {
		t.Errorf("after another restart %v (not persisted?)", got.CheckoutPaths)
	}
}

// A branch's default-path worktree switched to another branch is its thread's checkout,
// never shared as the branch's: making the branch's worktree is refused, naming the path,
// its HEAD, the thread in it and the way out (a Create, a child asking for its creator's
// branch, a start making a missing member again). Another worktree on the branch is
// shared as before.
func TestMovedDefaultWorktreeIsNotTheBranchs(t *testing.T) {
	e, rr := multiEnv(t, func(o *Options) {
		o.Projects.(*recordingProjects).MakeDirs = true
		o.RefExists = func(_ context.Context, _, ref string) bool { return ref == "refs/heads/feat/m" }
	})
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/m"}})
	moved := s.CheckoutPaths["r1"]
	switchBranch(rr, "r1", moved, "other")
	calls := len(rr.created())

	refused := func(what string, err error) {
		t.Helper()
		if !errors.Is(err, ErrFailedPrecondition) || !strings.Contains(err.Error(), moved) || !strings.Contains(err.Error(), "has other checked out now") ||
			!strings.Contains(err.Error(), "thread "+holderLabel(s)) || !strings.Contains(err.Error(), "switch it back to feat/m, or pick another branch") {
			t.Errorf("%s: err = %v, want the refusal naming %s, other, thread %s and the way out", what, err, moved, s.ID)
		}
	}
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1"}, NewWorktree: &NewWorktree{Branch: "feat/m"}})
	refused("a create on the branch", err)
	_, err = e.m.Create(e.ctx(), CreateOptions{CreatedBy: s.ID, NewWorktree: &NewWorktree{Branch: "feat/m"}})
	refused("a child asking for its creator's branch", err)
	if n := len(rr.created()); n != calls {
		t.Errorf("CreateWorktree calls %d after the refusals, want %d", n, calls)
	}

	// A start making a missing member again on the branch is refused the same way.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	e.m.update(s.ID, true, func(r *record) { r.s = r.s.withCheckout("r1", filepath.Join(t.TempDir(), "gone")) })
	_, err = e.m.Send(e.ctx(), s.ID, Message{Text: "again"})
	if err == nil {
		got := e.waitFor(s.ID, "the start failed", func(t Thread) bool { return t.State == StateDisconnected && t.LastError != "" })
		err = errors.New(got.LastError)
	}
	if !strings.Contains(err.Error(), "has other checked out now") {
		t.Errorf("start with the member's default path moved: %v", err)
	}

	// Another linked worktree on the branch is the branch's: shared, nothing made.
	other := mkWorktree(t, rr, "r1", "feat/m-by-hand")
	switchBranch(rr, "r1", other, "feat/m")
	c := e.create(CreateOptions{ProjectIDs: []string{"r1"}, NewWorktree: &NewWorktree{Branch: "feat/m"}})
	if c.WorktreePath != other || c.CheckoutPaths["r1"] != other {
		t.Errorf("created %+v, want the worktree on feat/m at %s", c, other)
	}
	if n := len(rr.created()); n != calls {
		t.Errorf("CreateWorktree calls %d, want %d (shared)", n, calls)
	}
}
