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

// failingProjects fails CreateWorktree for one project.
type failingProjects struct {
	*recordingProjects
	fail string
}

func (f failingProjects) CreateWorktree(ctx context.Context, o project.CreateWorktreeOptions) (project.Worktree, error) {
	if o.ProjectID == f.fail {
		return project.Worktree{}, errors.New("fatal: invalid reference")
	}
	return f.recordingProjects.CreateWorktree(ctx, o)
}

// multiEnv is a worktree env with a second git project, api (r2), beside repo (r1).
func multiEnv(t *testing.T, mutate ...func(*Options)) (*env, *recordingProjects) {
	t.Helper()
	e, rr := newWorktreeEnv(t, nil, mutate...)
	api := filepath.Join(t.TempDir(), "api")
	if err := os.MkdirAll(api, 0o755); err != nil {
		t.Fatal(err)
	}
	rr.Put(project.Project{ID: "r2", Path: api, Name: "api", Git: true, Worktrees: []project.Worktree{{ProjectID: "r2", Path: api, IsMain: true, Branch: "main"}}})
	return e, rr
}

// A thread with two projects in worktree mode: a worktree on one branch in each, made
// in parallel; the other member is an --add-dir; Checkouts finds it from either; a
// child inherits the set and the branch and shares the worktrees; a member removed by
// hand is made again at the next start.
func TestMultiProjectWorktreeThread(t *testing.T) {
	e, rr := multiEnv(t, func(o *Options) { o.Projects.(*recordingProjects).MakeDirs = true })
	s := e.create(CreateOptions{ProjectID: "r2", ProjectIDs: []string{"r1", "api"}, InitialPrompt: "fix login",
		NewWorktree: &NewWorktree{Branch: "feat/login"}})
	if !slices.Equal(s.ProjectIDs, []string{"r1", "r2"}) || s.ProjectID != "r2" || !s.CreatedWorktree || s.Branch != "feat/login" {
		t.Fatalf("created %+v", s)
	}
	created := rr.created()
	if len(created) != 2 || created[0].Branch != "feat/login" || created[1].Branch != "feat/login" {
		t.Fatalf("CreateWorktree calls %+v", created)
	}
	tc, err := e.m.Checkouts(e.ctx(), CheckoutsRef{ID: s.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(tc.Checkouts) != 2 || tc.Checkouts[1].Path != s.WorktreePath || !tc.Checkouts[1].Primary || tc.Current != 1 {
		t.Fatalf("checkouts %+v", tc)
	}
	repoWT := tc.Checkouts[0].Path
	if !strings.HasSuffix(repoWT, "feat-login") || tc.Checkouts[0].Missing {
		t.Fatalf("repo checkout %+v", tc.Checkouts[0])
	}
	if dirs := addDirs(e.spec(s.ID).Argv); !slices.Contains(dirs, repoWT) || slices.Contains(dirs, s.WorktreePath) {
		t.Errorf("add-dirs %q, want the repo worktree %s and not the cwd", dirs, repoWT)
	}
	byCwd, err := e.m.Checkouts(e.ctx(), CheckoutsRef{Cwd: filepath.Join(repoWT, "sub", "dir")})
	if err != nil || byCwd.Thread.ID != s.ID || byCwd.Current != 0 {
		t.Fatalf("checkouts by cwd = %+v, %v", byCwd, err)
	}

	// A child made inside it copies the set, branch and mode, and shares the worktrees.
	child := e.create(CreateOptions{CreatedBy: s.ID, ProjectID: "r1", InitialPrompt: "review"})
	if !slices.Equal(child.ProjectIDs, s.ProjectIDs) || child.Branch != s.Branch || !child.CreatedWorktree || child.WorktreePath != repoWT {
		t.Fatalf("child %+v", child)
	}
	if n := len(rr.created()); n != 2 {
		t.Errorf("%d CreateWorktree calls after the child, want the 2 the parent made", n)
	}
	hints := e.m.CheckoutHints(child)
	if len(hints) != 2 || !strings.Contains(hints[0], "repo @ feat/login is also open in") {
		t.Errorf("hints %q", hints)
	}

	// A member removed by hand is made again before the next start.
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Close(e.ctx(), child.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(repoWT); err != nil {
		t.Fatal(err)
	}
	r, _ := rr.Snapshot().Project("r1")
	r.Worktrees = slices.DeleteFunc(slices.Clone(r.Worktrees), func(w project.Worktree) bool { return w.Path == repoWT })
	rr.Put(r)
	if _, err := e.m.Send(e.ctx(), s.ID, Message{Text: "again"}); err != nil {
		t.Fatal(err)
	}
	e.waitFor(s.ID, "connected again", func(s Thread) bool { return s.State == StateConnected })
	if !isDir(repoWT) {
		t.Errorf("the removed member worktree %s was not made again", repoWT)
	}
	if got := rr.created(); len(got) != 3 || got[2].ProjectID != "r1" || got[2].Branch != "feat/login" {
		t.Errorf("CreateWorktree calls %+v, want a third for r1 on feat/login", got)
	}
}

// One member that cannot be made fails the Create, naming the project, and the
// worktrees the others got are removed again.
func TestMultiProjectCreateRollsBack(t *testing.T) {
	var fp failingProjects
	e, _ := multiEnv(t, func(o *Options) {
		fp = failingProjects{recordingProjects: o.Projects.(*recordingProjects), fail: "r2"}
		o.Projects = fp
	})
	_, err := e.m.Create(e.ctx(), CreateOptions{ProjectIDs: []string{"r1", "r2"}, NewWorktree: &NewWorktree{Branch: "feat/x"}})
	if err == nil || !strings.Contains(err.Error(), "in api") {
		t.Fatalf("err = %v, want one naming api", err)
	}
	if calls := fp.Calls; !slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "RemoveWorktree r1 ") }) {
		t.Errorf("calls %q, want the r1 worktree removed again", calls)
	}
	if n := len(e.m.Snapshot().Threads); n != 0 {
		t.Errorf("%d threads after a failed create", n)
	}
}

// RunIn moves a multi-project thread between its checkouts and refuses anything else.
func TestRunInCheckouts(t *testing.T) {
	e, _ := multiEnv(t)
	s := e.create(CreateOptions{ProjectIDs: []string{"r1", "r2"}})
	if s.ProjectID != "r1" || s.CreatedWorktree {
		t.Fatalf("created %+v", s)
	}
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	moved, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "api"})
	if err != nil {
		t.Fatal(err)
	}
	api, _ := e.projects.Snapshot().Project("r2")
	if moved.ProjectID != "r2" || moved.WorktreePath != api.Path {
		t.Errorf("moved %+v", moved)
	}
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{WorktreePath: t.TempDir()}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("RunIn outside the checkouts = %v", err)
	}
	if _, err := e.m.RunIn(e.ctx(), s.ID, RunInTarget{ProjectID: "nope"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("RunIn to another project = %v", err)
	}
}
