package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Where a new thread goes (docs/notes/workspaces-v2-handoff.md §4,
// docs/notes/workspaces-v2-1-threads.md): its project set, primary, mode and branch,
// from CreateOptions and, with Like or a creator, from another thread.
//
// Inheritance: a thread made by another thread (CreatedBy) copies its creator's project
// set, branch, workspace reference, primary and mode unless the options place it
// elsewhere: ProjectIDs narrows (or replaces) the set, NewWorktree or NewBranch branches
// off, CheckoutMode runs in the members' own checkouts, ProjectID alone keeps the set
// and picks the primary. A ProjectID or WorktreePath outside the creator's set places
// the thread there instead, as before (an orchestrator in one project starting a worker
// in another). Like is the same, explicit: a ProjectID or WorktreePath outside its set
// is an error.

// placeRequest is what CreateOptions says about placement, with project refs resolved
// to ids.
type placeRequest struct {
	// projectIDs is ProjectIDs resolved, in the given order; nil when not given.
	projectIDs []string
	// primary is ProjectID resolved; "" when not given.
	primary string
	// worktree is WorktreePath (cleaned) and worktreeProject its project; "" when not
	// given.
	worktree, worktreeProject string
	// newBranch: NewWorktree or NewBranch.
	newBranch    bool
	checkoutMode bool
	// workspaceID is WorkspaceID resolved, with the workspace's members and default
	// primary; wsPrimary: ProjectID is workspace.PrimaryWorkspace.
	workspaceID string
	wsMembers   []string
	wsDefault   string
	wsPrimary   bool
}

// placement is where a new thread goes.
type placement struct {
	noProject bool
	// projectIDs is the set, sorted (CleanProjectIDs).
	projectIDs []string
	primary    string
	// primaryPath is the primary's cwd in checkout mode when it is not the project's own
	// checkout (a worktree the options or the copied thread name); "" otherwise.
	primaryPath  string
	worktreeMode bool
	// branch is the existing branch of a worktree-mode placement copied from another
	// thread; "" with newBranch.
	branch      string
	newBranch   bool
	workspaceID string
	// workspacePrimary: the thread runs in its workspace's folder (its root, else its
	// managed dir); primary is "".
	workspacePrimary bool
	// from is the thread the placement copied (Like or the creator); "" when none.
	from string
}

// decidePlacement is the placement for req, copying from src when it is set (Like when
// explicit, else the creator). srcCheckouts are src's checkouts (checkoutsOf). Pure.
func decidePlacement(src *Thread, explicit bool, req placeRequest, srcCheckouts []Checkout) (placement, error) {
	if req.workspaceID != "" {
		return workspacePlacement(req) // told where: the workspace, not the copied thread
	}
	if src != nil && len(src.Projects()) == 0 && src.WorkspaceID == "" {
		if !explicit {
			src = nil // a creator without a project has nothing to pass on
		} else if req.primary == "" && req.worktree == "" && len(req.projectIDs) == 0 {
			if req.newBranch {
				return placement{}, fmt.Errorf("%w: thread %s has no project to branch", ErrInvalidArgument, src.ID)
			}
			return placement{noProject: true, primaryPath: src.WorktreePath, from: src.ID}, nil
		} else {
			src = nil // nothing to copy but the cwd; the options place it
		}
	}
	if src != nil {
		set := src.Projects()
		ok := true
		var primary string
		switch {
		case req.worktree != "":
			i := slices.IndexFunc(srcCheckouts, func(c Checkout) bool { return c.Path != "" && samePath(c.Path, req.worktree) })
			if i < 0 {
				if explicit {
					return placement{}, fmt.Errorf("%w: %s is not a checkout of thread %s", ErrInvalidArgument, req.worktree, src.ID)
				}
				ok = false
			} else {
				primary = srcCheckouts[i].ProjectID
			}
		case req.primary != "" && len(req.projectIDs) == 0 && !slices.Contains(set, req.primary):
			if explicit {
				return placement{}, fmt.Errorf("%w: project %s is not one of thread %s's projects (%s); give the set with projects",
					ErrInvalidArgument, req.primary, src.ID, strings.Join(set, ", "))
			}
			ok = false
		}
		if ok {
			return copyPlacement(*src, req, primary)
		}
	}
	return plainPlacement(req)
}

// copyPlacement is req's placement copying src. primary is the member req.worktree is
// a checkout of, when given.
func copyPlacement(src Thread, req placeRequest, primary string) (placement, error) {
	pl := placement{projectIDs: src.Projects(), workspaceID: src.WorkspaceID, from: src.ID}
	if len(req.projectIDs) > 0 {
		pl.projectIDs = CleanProjectIDs("", req.projectIDs)
	}
	pl.primary = cmp.Or(primary, req.primary)
	if pl.primary == "" && slices.Contains(pl.projectIDs, src.ProjectID) {
		pl.primary = src.ProjectID
	}
	if pl.primary == "" && src.ProjectID == "" && src.WorkspaceID != "" {
		pl.workspacePrimary = true // the copied thread runs in its workspace's folder
	} else if pl.primary == "" {
		pl.primary = pl.projectIDs[0]
	}
	if !pl.workspacePrimary && !slices.Contains(pl.projectIDs, pl.primary) {
		return placement{}, fmt.Errorf("%w: project %s is not among the thread's projects (%s)", ErrInvalidArgument, pl.primary, strings.Join(pl.projectIDs, ", "))
	}
	switch {
	case req.newBranch:
		pl.worktreeMode, pl.newBranch = true, true
	case req.checkoutMode:
	case src.worktreeMode():
		pl.worktreeMode, pl.branch = true, src.Branch
	}
	if !pl.worktreeMode {
		switch {
		case req.worktree != "":
			pl.primaryPath = req.worktree
		case !pl.workspacePrimary && pl.primary == src.ProjectID && !src.worktreeMode():
			pl.primaryPath = src.WorktreePath // the copied thread's own cwd (a user's worktree)
		}
	}
	return pl, nil
}

// workspacePlacement is req's placement with a workspace (WorkspaceID): its members are
// the set unless ProjectIDs gives one; the primary is ProjectID
// (workspace.PrimaryWorkspace for its folder), else the worktree's project, else the
// workspace's default primary when it is the folder or in the set, else the first project
// given; a workspace without projects runs in its folder.
func workspacePlacement(req placeRequest) (placement, error) {
	pl := placement{worktreeMode: req.newBranch, newBranch: req.newBranch, workspaceID: req.workspaceID}
	given := req.projectIDs
	if len(given) == 0 {
		given = req.wsMembers
	}
	pl.projectIDs = CleanProjectIDs("", given)
	pl.primary = cmp.Or(req.primary, req.worktreeProject)
	switch {
	case req.wsPrimary:
		pl.primary, pl.workspacePrimary = "", true
	case pl.primary != "":
		if !slices.Contains(pl.projectIDs, pl.primary) {
			return placement{}, fmt.Errorf("%w: project %s is not among the thread's projects (%s)", ErrInvalidArgument, pl.primary, strings.Join(pl.projectIDs, ", "))
		}
	case req.wsDefault == workspace.PrimaryWorkspace, len(given) == 0:
		pl.workspacePrimary = true
	case slices.Contains(pl.projectIDs, req.wsDefault):
		pl.primary = req.wsDefault
	default:
		pl.primary = given[0]
	}
	if !pl.worktreeMode && !pl.workspacePrimary {
		pl.primaryPath = req.worktree
	}
	return pl, nil
}

// plainPlacement is req's placement without a thread to copy.
func plainPlacement(req placeRequest) (placement, error) {
	pl := placement{worktreeMode: req.newBranch, newBranch: req.newBranch}
	pl.primary = cmp.Or(req.primary, req.worktreeProject)
	if len(req.projectIDs) > 0 {
		pl.projectIDs = CleanProjectIDs("", req.projectIDs)
		if pl.primary == "" {
			pl.primary = req.projectIDs[0] // the first given, not the first by id
		}
		if !slices.Contains(pl.projectIDs, pl.primary) {
			return placement{}, fmt.Errorf("%w: project %s is not among projects %s", ErrInvalidArgument, pl.primary, strings.Join(pl.projectIDs, ", "))
		}
	} else {
		pl.projectIDs = CleanProjectIDs(pl.primary, nil)
	}
	if pl.primary == "" && req.worktree == "" {
		if req.newBranch {
			return placement{}, fmt.Errorf("%w: a project is required for a new worktree", ErrInvalidArgument)
		}
		return placement{}, fmt.Errorf("%w: a project, a worktree path, a workspace or no project is required", ErrInvalidArgument)
	}
	if req.worktree != "" && req.worktreeProject != "" && req.worktreeProject != pl.primary {
		return placement{}, fmt.Errorf("%w: %s is not a worktree of project %s", ErrFailedPrecondition, req.worktree, pl.primary)
	}
	if !pl.worktreeMode {
		pl.primaryPath = req.worktree
	}
	return pl, nil
}

// placedThread is a placement carried out: the thread's fields, and what Create made.
type placedThread struct {
	noProject                        bool
	projectIDs                       []string
	projectID, path, baseRef, branch string
	createdWorktree                  bool
	workspaceID                      string
	// name is the namer's title when it arrived within SlugTimeout; namerCalled: the
	// namer was started for this thread; late delivers its answer when it was late.
	name        string
	namerCalled bool
	late        <-chan namingResult
	// made are the worktrees this Create made, for the worktree-created hook.
	made []madeWorktree
}

// madeWorktree is a member worktree a Create or a start made.
type madeWorktree struct {
	projectID, path string
	// newBranch: the branch did not exist; a rollback deletes it too.
	newBranch bool
	// startPoint is project.Worktree.StartPoint.
	startPoint string
	worktree   project.Worktree
}

// placeThread decides and carries out a new thread's placement (decidePlacement) for
// Create: it resolves the options' project refs, finds the thread to copy (o.Like, else
// the creator), and in worktree mode names the branch (one namer wait, as a new
// worktree's) and makes every git member's worktree in parallel. A failure removes what
// it made and names the project.
func (m *Manager) placeThread(ctx context.Context, id, name, creatorID string, o CreateOptions) (placedThread, error) {
	var p placedThread
	req, bases, err := m.placeRequest(o)
	if err != nil {
		return p, err
	}
	var src *Thread
	explicit := strings.TrimSpace(o.Like) != ""
	switch {
	case explicit:
		t, ok := m.Snapshot().Thread(strings.TrimSpace(o.Like))
		if !ok {
			return p, fmt.Errorf("%w: like: thread %s not found", ErrInvalidArgument, o.Like)
		}
		src = &t
	case creatorID != "":
		if t, ok := m.Snapshot().Thread(creatorID); ok {
			src = &t
		}
	}
	if o.NewBranch && req.workspaceID == "" && (src == nil || len(src.Projects()) == 0) {
		return p, fmt.Errorf("%w: new branch needs like (or a creating thread with a project) to branch from", ErrInvalidArgument)
	}
	var srcCheckouts []Checkout
	if src != nil {
		srcCheckouts = m.checkouts(*src)
	}
	pl, err := decidePlacement(src, explicit, req, srcCheckouts)
	if err != nil {
		return p, err
	}
	if pl.from != "" {
		m.log.Info("new thread placed like another", "thread", id, "from", pl.from, "explicit", explicit,
			"projects", pl.projectIDs, "worktree_mode", pl.worktreeMode, "branch", pl.branch, "new_branch", pl.newBranch)
	}
	if pl.noProject {
		p.noProject = true
		p.path, err = m.noProjectCwd(pl.primaryPath)
		return p, err
	}
	p.projectIDs, p.projectID, p.workspaceID = pl.projectIDs, pl.primary, pl.workspaceID
	if pl.workspacePrimary {
		// The workspace's folder: its root, else its managed dir (made by workspaceDir).
		w, err := m.workspaceDir(pl.workspaceID)
		if err != nil {
			return p, err
		}
		p.path = w.Dir()
		if !pl.worktreeMode {
			return p, nil
		}
	}
	if !pl.worktreeMode {
		p.path = pl.primaryPath
		if p.path == "" {
			if _, p.path, err = m.resolveWorktree(pl.primary, ""); err != nil {
				return p, err
			}
		}
		return p, nil
	}
	return m.placeWorktrees(ctx, id, name, o, pl, bases, p)
}

// placeRequest resolves o's project refs: ProjectIDs (each "<ref>[:<base>]"; bases by
// project id), ProjectID and WorktreePath.
func (m *Manager) placeRequest(o CreateOptions) (placeRequest, map[string]string, error) {
	req := placeRequest{newBranch: o.NewWorktree != nil || o.NewBranch, checkoutMode: o.CheckoutMode}
	if req.newBranch && req.checkoutMode {
		return req, nil, fmt.Errorf("%w: checkout mode excludes a new worktree or branch", ErrInvalidArgument)
	}
	var snap *project.Snapshot
	if m.opts.Projects != nil {
		snap = m.opts.Projects.Snapshot()
	}
	resolve := func(ref string) (string, error) {
		if m.opts.Projects == nil {
			return ref, nil
		}
		r, err := m.projectByRef(snap, ref)
		return r.ID, err
	}
	bases := map[string]string{}
	for _, item := range o.ProjectIDs {
		ref, base, _ := strings.Cut(item, ":")
		ref, base = strings.TrimSpace(ref), strings.TrimSpace(base)
		if ref == "" {
			continue
		}
		if err := validateRef(base); err != nil {
			return req, nil, err
		}
		pid, err := resolve(ref)
		if err != nil {
			return req, nil, err
		}
		if slices.Contains(req.projectIDs, pid) {
			return req, nil, fmt.Errorf("%w: project %s is listed twice", ErrInvalidArgument, ref)
		}
		req.projectIDs = append(req.projectIDs, pid)
		if base != "" {
			bases[pid] = base
		}
	}
	// "workspace" as the project is the workspace's folder, unless a registered project
	// answers to it (workspace.IsKeyword): then it is that project.
	keyword := m.opts.Projects == nil && strings.EqualFold(strings.TrimSpace(o.ProjectID), workspace.PrimaryWorkspace) ||
		m.opts.Projects != nil && workspace.IsKeyword(snap, o.ProjectID)
	if ref := strings.TrimSpace(o.WorkspaceID); ref != "" {
		// The folder is checked only when the thread runs there (placeThread): a moved
		// root does not stop a thread in a member.
		w, err := m.resolveWorkspace(ref)
		if err != nil {
			return req, nil, err
		}
		req.workspaceID, req.wsMembers, req.wsDefault = w.ID, w.Members, w.DefaultPrimary
		if keyword {
			req.wsPrimary = true
			o.ProjectID = ""
		}
	} else if keyword {
		return req, nil, fmt.Errorf("%w: project %q (the workspace's folder) needs a workspace", ErrInvalidArgument, o.ProjectID)
	}
	if o.ProjectID != "" {
		pid, err := resolve(o.ProjectID)
		if err != nil {
			return req, nil, err
		}
		req.primary = pid
	}
	switch {
	case o.WorktreePath == "":
	case o.NewWorktree == nil:
		pid, path, err := m.resolveWorktree(req.primary, o.WorktreePath)
		if err != nil {
			return req, nil, err
		}
		req.worktree, req.worktreeProject = path, pid
	case req.primary == "":
		// A new worktree ignores the path but takes its project.
		pid, _, err := m.resolveWorktree("", o.WorktreePath)
		if err != nil {
			return req, nil, err
		}
		req.primary = pid
	}
	return req, bases, nil
}

// placeWorktrees carries out a worktree-mode placement: the branch (named for a new
// one), then every git member's worktree, made in parallel where missing.
func (m *Manager) placeWorktrees(ctx context.Context, id, name string, o CreateOptions, pl placement, bases map[string]string, p placedThread) (placedThread, error) {
	if m.opts.Projects == nil {
		return p, fmt.Errorf("%w: creating a worktree needs the project store", ErrFailedPrecondition)
	}
	snap := m.opts.Projects.Snapshot()
	var git []project.Project
	var plain *project.Project
	for _, pid := range pl.projectIDs {
		r, err := m.projectByRef(snap, pid)
		if err != nil {
			return p, err
		}
		if r.Git {
			git = append(git, r)
		} else if plain == nil || r.ID == pl.primary {
			plain = &r
		}
	}
	if len(git) == 0 && plain == nil {
		return p, fmt.Errorf("%w: new worktrees need a project with git; the thread has none", ErrFailedPrecondition)
	}
	if len(git) == 0 {
		// Before the namer: a project without git runs threads in its one checkout.
		return p, fmt.Errorf("%w: %s is not a git repository; threads run in its current checkout", ErrFailedPrecondition, plain.Name)
	}
	var nw NewWorktree
	if o.NewWorktree != nil {
		nw = *o.NewWorktree
	}
	base := strings.TrimSpace(nw.BaseRef)
	if err := validateRef(base); err != nil {
		return p, err
	}
	branch, fresh := pl.branch, false
	if pl.newBranch {
		bc, err := m.newBranchChoice(nw.Branch)
		if err != nil {
			return p, err
		}
		sl, err := m.waitNaming(ctx, id, name, o.InitialPrompt, bc)
		if err != nil {
			return p, err
		}
		p.name, p.namerCalled, p.late = sl.name, sl.namerCalled, sl.late
		paths := make([]string, len(git))
		for i, r := range git {
			paths[i] = r.Path
		}
		var existing bool
		branch, existing = m.pickBranch(ctx, paths, bc, sl.branch, id, nil)
		if existing && (base != "" || len(bases) > 0) {
			m.log.Info("branch exists; checking it out and ignoring the base", "thread", id, "branch", branch, "base", base)
			base, bases = "", nil
		}
		fresh = !existing
	}
	fromOrigin := m.fromOrigin(nw.BaseFromOrigin)
	made, err := m.makeWorktrees(ctx, git, branch, func(pid string) string { return cmp.Or(bases[pid], base) }, fresh, fromOrigin)
	if err != nil {
		return p, err
	}
	p.made, p.branch, p.createdWorktree = made, branch, true
	for _, r := range git {
		if r.ID != pl.primary {
			continue
		}
		wt, _ := m.memberWorktree(r, branch)
		p.path = wt.Path
		var start string
		if i := slices.IndexFunc(made, func(w madeWorktree) bool { return w.projectID == r.ID }); i >= 0 {
			wt, start = made[i].worktree, made[i].startPoint
			p.path = made[i].path
		}
		pbase := cmp.Or(bases[r.ID], base)
		p.baseRef = cmp.Or(start, pbase, wt.Status.BaseRef, r.DefaultBranch)
	}
	if p.path == "" { // the primary is a plain folder: it runs there
		if _, p.path, err = m.resolveWorktree(pl.primary, ""); err != nil {
			m.rollback(ctx, made)
			return p, err
		}
	}
	m.log.Info("worktrees ready for thread", "thread", id, "projects", pl.projectIDs, "branch", branch,
		"made", len(made), "cwd", p.path, "base", p.baseRef)
	return p, nil
}

// memberWorktree is r's existing worktree for branch (derivedWorktree) when it is on
// disk.
func (m *Manager) memberWorktree(r project.Project, branch string) (project.Worktree, bool) {
	if cur, ok := m.opts.Projects.Snapshot().Project(r.ID); ok {
		r = cur
	}
	w, ok := derivedWorktree(r, branch, m.opts.Projects.DefaultWorktreePath(r.ID, branch))
	if !ok || !isDir(w.Path) {
		return project.Worktree{}, false
	}
	return w, true
}

// makeWorktrees makes the worktree for branch in each of projects that has none, in
// parallel, and returns what it made. base gives a member's base for a new branch. One
// failure removes what the others made and is the error, naming the project.
func (m *Manager) makeWorktrees(ctx context.Context, projects []project.Project, branch string, base func(string) string, fresh, fromOrigin bool) ([]madeWorktree, error) {
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		made []madeWorktree
		errs []error
	)
	for _, r := range projects {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mw, ok, err := m.makeWorktree(ctx, r, branch, base(r.ID), fresh, fromOrigin)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err != nil:
				errs = append(errs, projectError("create worktree "+branch+" in "+r.Name, err))
			case ok:
				made = append(made, mw)
			}
		}()
	}
	wg.Wait()
	slices.SortFunc(made, func(a, b madeWorktree) int { return strings.Compare(a.projectID, b.projectID) })
	if len(errs) > 0 {
		m.rollback(ctx, made)
		return nil, errors.Join(errs...)
	}
	return made, nil
}

// makeWorktree makes r's worktree for branch unless it exists (ok false then): the
// local branch, else origin's (looked up, then fetched), else a new branch from base;
// fresh says the branch is known to be new. It pre-trusts the worktree for Claude. Two
// threads making the same (project, branch) wait for each other, and the second finds
// the first's.
func (m *Manager) makeWorktree(ctx context.Context, r project.Project, branch, base string, fresh, fromOrigin bool) (madeWorktree, bool, error) {
	unlock := m.lockWorktree(r.ID, branch)
	defer unlock()
	if _, ok := m.memberWorktree(r, branch); ok && !fresh {
		return madeWorktree{}, false, nil // a new branch has no worktree yet
	}
	opts := project.CreateWorktreeOptions{ProjectID: r.ID, Branch: branch, Fetch: true, BaseFromOrigin: fromOrigin}
	newBranch := fresh
	if !fresh {
		local := m.opts.RefExists(ctx, r.Path, "refs/heads/"+branch)
		remote := !local && (m.opts.RefExists(ctx, r.Path, "refs/remotes/origin/"+branch) || m.opts.FetchBranch(ctx, r.Path, branch))
		newBranch = !local && !remote
	}
	if newBranch {
		opts.BaseRef = base
	}
	wt, err := m.opts.Projects.CreateWorktree(ctx, opts)
	if err != nil {
		return madeWorktree{}, false, err
	}
	if !m.opts.DisablePreTrust {
		if _, err := trustWorktree(m.opts.Paths.Config, wt.Path); err != nil {
			m.log.Warn("pre-trust worktree failed", "project", r.ID, "path", wt.Path, "err", err)
		}
	}
	m.log.Info("member worktree made", "project", r.ID, "branch", branch, "path", wt.Path, "new_branch", newBranch, "start_point", wt.StartPoint)
	return madeWorktree{projectID: r.ID, path: filepath.Clean(wt.Path), newBranch: newBranch, startPoint: wt.StartPoint, worktree: wt}, true, nil
}

// rollback removes worktrees a failed Create made, with the branches it made for them.
// It runs even when ctx is cancelled.
func (m *Manager) rollback(ctx context.Context, made []madeWorktree) {
	ctx = context.WithoutCancel(ctx)
	for _, w := range made {
		if err := m.opts.Projects.RemoveWorktree(ctx, project.RemoveWorktreeOptions{
			ProjectID: w.projectID, Path: w.path, Force: true, DeleteBranch: w.newBranch,
		}); err != nil {
			m.log.Warn("remove a worktree a failed create made", "project", w.projectID, "path", w.path, "err", err)
		}
	}
}

// lockWorktree serializes making (project, branch)'s worktree within the store.
func (m *Manager) lockWorktree(projectID, branch string) (unlock func()) {
	v, _ := m.wtLocks.LoadOrStore(projectID+"\x00"+branch, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// ensureMembers makes the missing worktrees of a worktree-mode thread's other members
// again (a cleanup or a hand removed them) before it starts, in parallel, and returns
// what it made. The primary's is recreate.go's (ensureWorktree).
func (m *Manager) ensureMembers(ctx context.Context, s Thread) ([]madeWorktree, error) {
	if !s.worktreeMode() || m.opts.Projects == nil {
		return nil, nil
	}
	snap := m.opts.Projects.Snapshot()
	var todo []project.Project
	for _, c := range m.checkouts(s) {
		if c.Primary || !c.Derived || !c.Missing || !c.Registered {
			continue
		}
		if r, ok := snap.Project(c.ProjectID); ok {
			todo = append(todo, r)
		}
	}
	if len(todo) == 0 {
		return nil, nil
	}
	m.update(s.ID, false, func(*record) {}) // STARTING now: the fetches may take seconds
	m.log.Info("member worktrees of thread are gone; making them again", "thread", s.ID, "projects", len(todo), "branch", s.Branch)
	made, err := m.makeWorktrees(ctx, todo, s.Branch, func(string) string { return "" }, false, m.opts.BaseFromOrigin())
	if err != nil {
		return nil, err
	}
	return made, nil
}
