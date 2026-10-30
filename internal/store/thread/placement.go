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
// in another). A ProjectIDs set without a git project drops worktree mode: there is
// nothing to put in a worktree. Like is the same, explicit: a ProjectID or WorktreePath
// outside its set is an error, and a WorkspaceID only replaces the workspace reference
// (a creator's is replaced by the workspace's placement). The CLI's --created-by= (an
// empty creator) opts out of the creator and of the caller's like alike.

// placeRequest is what CreateOptions says about placement, with project refs resolved
// to ids.
type placeRequest struct {
	// projectIDs is ProjectIDs resolved, in the given order; nil when not given.
	projectIDs []string
	// noGit: projectIDs is given and none of them has git (plain folders only).
	noGit bool
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
	// droppedWorktreeMode: the copied thread works in worktrees, but the set given has no
	// git project, so this one runs in the folders (checkout mode).
	droppedWorktreeMode bool
}

// decidePlacement is the placement for req, copying from src when it is set (Like when
// explicit, else the creator). srcCheckouts are src's checkouts (checkoutsOf). Pure.
func decidePlacement(src *Thread, explicit bool, req placeRequest, srcCheckouts []Checkout) (placement, error) {
	if req.wsPrimary && req.workspaceID == "" && (src == nil || !explicit || src.WorkspaceID == "") {
		// The like thread's own workspace folder: only a like thread with a workspace has one.
		why := ""
		if src != nil {
			why = "; thread " + src.ID + " has none"
		}
		return placement{}, fmt.Errorf("%w: project %q (the workspace's folder) needs a workspace%s", ErrInvalidArgument, workspace.PrimaryWorkspace, why)
	}
	if req.workspaceID != "" && !explicit {
		return workspacePlacement(req) // told where: the workspace, not the creator
	}
	if src != nil && len(src.Projects()) == 0 && src.WorkspaceID == "" {
		if !explicit {
			src = nil // a creator without a project has nothing to pass on
		} else if req.primary == "" && req.worktree == "" && len(req.projectIDs) == 0 && req.workspaceID == "" {
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
	if req.workspaceID != "" {
		return workspacePlacement(req) // a like without a project: the workspace places it
	}
	return plainPlacement(req)
}

// copyPlacement is req's placement copying src. primary is the member req.worktree is
// a checkout of, when given. A workspace req gives (with Like) replaces src's reference
// and nothing else; its folder as the primary (wsPrimary) replaces src's primary.
func copyPlacement(src Thread, req placeRequest, primary string) (placement, error) {
	pl := placement{projectIDs: src.Projects(), workspaceID: cmp.Or(req.workspaceID, src.WorkspaceID), from: src.ID}
	if len(req.projectIDs) > 0 {
		pl.projectIDs = CleanProjectIDs("", req.projectIDs)
	}
	if req.wsPrimary {
		pl.workspacePrimary = true
		switch {
		case req.newBranch:
			pl.worktreeMode, pl.newBranch = true, true
		case req.checkoutMode:
		case src.worktreeMode() && req.noGit:
			pl.droppedWorktreeMode = true
		case src.worktreeMode():
			pl.worktreeMode, pl.branch = true, src.Branch
		}
		return pl, nil
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
	case src.worktreeMode() && req.noGit:
		pl.droppedWorktreeMode = true // plain folders only: nothing to put in a worktree
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
	// checkouts is every member's checkout (Thread.CheckoutPaths): "" for one that could
	// not be placed (a project no longer registered), resolved at its first start.
	checkouts map[string]string
	// name is the namer's title when it arrived within SlugTimeout; namerCalled: the
	// namer was started for this thread; late delivers its answer when it was late.
	name        string
	namerCalled bool
	late        <-chan namingResult
	// made are the worktrees this Create made, for the worktree-created hook.
	made []madeWorktree
	// droppedWorktreeMode is placement.droppedWorktreeMode; madePrimary: this Create made
	// the primary's worktree; reusedPrimary: it existed (the summary, CreateReport).
	droppedWorktreeMode, madePrimary, reusedPrimary, madeBranch bool
}

// madeWorktree is a member worktree a Create or a start made.
type madeWorktree struct {
	projectID, projectName, path string
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
	// A like without a project gets decidePlacement's "has no project to branch".
	if o.NewBranch && req.workspaceID == "" && (src == nil || (!explicit && len(src.Projects()) == 0)) {
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
	var shared map[string]string
	if src != nil && pl.from == src.ID {
		shared = sharedCheckouts(*src, pl, srcCheckouts)
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
	p.droppedWorktreeMode = pl.droppedWorktreeMode
	if pl.workspacePrimary {
		// The workspace's folder: its root, else its managed dir (made by workspaceDir).
		w, err := m.workspaceDir(pl.workspaceID)
		if err != nil {
			return p, err
		}
		p.path = w.Dir()
		if !pl.worktreeMode {
			p.checkouts = m.ownCheckouts(pl.projectIDs, "", "", shared)
			return p, nil
		}
	}
	if !pl.worktreeMode {
		p.path = cmp.Or(pl.primaryPath, shared[pl.primary])
		if p.path == "" {
			if _, p.path, err = m.resolveWorktree(pl.primary, ""); err != nil {
				return p, err
			}
		}
		p.checkouts = m.ownCheckouts(pl.projectIDs, pl.primary, p.path, shared)
		return p, nil
	}
	return m.placeWorktrees(ctx, id, name, o, pl, bases, shared, p)
}

// sharedCheckouts are the checkouts a thread placed like src shares with it: when it
// keeps src's mode (and in worktree mode src's branch, not a new one), each of src's
// checkouts that is on disk, by project id. A member src does not have, or whose
// checkout is gone, is placed by the creation rule. nil when nothing is shared (a new
// branch, or another mode). Pure.
func sharedCheckouts(src Thread, pl placement, srcCheckouts []Checkout) map[string]string {
	if pl.newBranch || pl.worktreeMode != src.worktreeMode() || (pl.worktreeMode && pl.branch != src.Branch) {
		return nil
	}
	var out map[string]string
	for _, c := range srcCheckouts {
		if c.Path == "" || c.Missing || !c.Registered || !slices.Contains(pl.projectIDs, c.ProjectID) {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[c.ProjectID] = c.Path
	}
	return out
}

// ownCheckouts records a checkout-mode placement's checkouts: the primary's is the cwd,
// a member shared with the copied thread its checkout there, every other member its own
// checkout (the main worktree, or the folder); "" for a project no longer registered.
func (m *Manager) ownCheckouts(ids []string, primary, cwd string, shared map[string]string) map[string]string {
	var snap *project.Snapshot
	if m.opts.Projects != nil {
		snap = m.opts.Projects.Snapshot()
	}
	out := make(map[string]string, len(ids))
	for _, id := range ids {
		switch r, ok := snap.Project(id); {
		case id == primary:
			out[id] = cwd
		case shared[id] != "":
			out[id] = shared[id]
		case ok:
			out[id] = mainCheckout(r)
		default:
			out[id] = ""
		}
	}
	return out
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
	anyGit := m.opts.Projects == nil // without a project store (tests) nothing is known
	resolve := func(ref string) (string, error) {
		if m.opts.Projects == nil {
			return ref, nil
		}
		r, err := m.projectByRef(snap, ref)
		anyGit = anyGit || (err == nil && r.Git)
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
	req.noGit = len(req.projectIDs) > 0 && !anyGit
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
	} else if keyword && strings.TrimSpace(o.Like) != "" {
		// The like thread's workspace folder, when it has a workspace (decidePlacement checks).
		req.wsPrimary = true
		o.ProjectID = ""
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
// one), then every git member's worktree, made in parallel where missing; a member in
// shared keeps the copied thread's worktree, whatever it has checked out now.
func (m *Manager) placeWorktrees(ctx context.Context, id, name string, o CreateOptions, pl placement, bases map[string]string, shared map[string]string, p placedThread) (placedThread, error) {
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
		paths := make([]string, len(git))
		for i, r := range git {
			paths[i] = r.Path
		}
		bc = m.existingBranchChoice(ctx, paths, bc, nw.Branch)
		sl, err := m.waitNaming(ctx, id, name, o.InitialPrompt, bc)
		if err != nil {
			return p, err
		}
		p.name, p.namerCalled, p.late = sl.name, sl.namerCalled, sl.late
		var existing bool
		var release func()
		branch, existing, release = m.pickBranch(ctx, paths, bc, sl.branch, id)
		defer release() // the worktrees are made (or rolled back) by then
		if existing && (base != "" || len(bases) > 0) {
			m.log.Info("branch exists; checking it out and ignoring the base", "thread", id, "branch", branch, "base", base)
			base, bases = "", nil
		}
		fresh = !existing
	}
	fromOrigin := m.fromOrigin(nw.BaseFromOrigin)
	var todo []project.Project
	for _, r := range git {
		if shared[r.ID] == "" {
			todo = append(todo, r)
		}
	}
	made, err := m.makeWorktrees(ctx, todo, branch, func(pid string) string { return cmp.Or(bases[pid], base) }, fresh, fromOrigin)
	if err != nil {
		return p, err
	}
	p.made, p.branch, p.createdWorktree = made, branch, true
	// The plain folders are their folders (or the copied thread's); each git member's
	// worktree is the one made, shared or reused.
	p.checkouts = m.ownCheckouts(pl.projectIDs, "", "", shared)
	for _, r := range git {
		var wt project.Worktree
		var start string
		i := slices.IndexFunc(made, func(w madeWorktree) bool { return w.projectID == r.ID })
		switch {
		case i >= 0:
			wt, start = made[i].worktree, made[i].startPoint
			wt.Path = made[i].path
		case shared[r.ID] != "":
			wt, _ = m.opts.Projects.Snapshot().Worktree(r.ID, shared[r.ID])
			wt.Path = shared[r.ID]
		default:
			wt, _ = m.memberWorktree(r, branch)
		}
		p.checkouts[r.ID] = wt.Path
		if r.ID != pl.primary {
			continue
		}
		p.path = wt.Path
		if i >= 0 {
			p.madePrimary, p.madeBranch = true, made[i].newBranch
		} else {
			p.reusedPrimary = true
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

// memberWorktree is r's existing worktree for branch when it is on disk: the one at the
// default path while it has branch checked out, else another linked worktree on branch
// (one made before the path rule, or by hand). A default-path worktree switched to
// another branch is not branch's (it is the checkout of whatever thread made it):
// making branch's worktree is refused while it is there (defaultPathTaken).
// branchWorktree, which takes the default path whatever it has checked out, stays the
// rule only for resolving a member with nothing recorded (the old derivation).
func (m *Manager) memberWorktree(r project.Project, branch string) (project.Worktree, bool) {
	if cur, ok := m.opts.Projects.Snapshot().Project(r.ID); ok {
		r = cur
	}
	want := m.opts.Projects.DefaultWorktreePath(r.ID, branch)
	onBranch := func(w project.Worktree) bool { return !w.IsMain && !w.Detached && w.Branch == branch }
	i := slices.IndexFunc(r.Worktrees, func(w project.Worktree) bool { return onBranch(w) && want != "" && samePath(w.Path, want) })
	if i < 0 {
		i = slices.IndexFunc(r.Worktrees, onBranch)
	}
	if i < 0 || !isDir(r.Worktrees[i].Path) {
		return project.Worktree{}, false
	}
	return r.Worktrees[i], true
}

// defaultPathTaken is the refusal to make r's worktree for branch while the path it would
// go to (the default path) holds another checkout: a worktree listed there with another
// HEAD (made for branch, then switched away: still its thread's checkout), or, with
// onDisk, a git checkout there that r does not list (checked under the per-branch lock,
// where a worktree another Create just made is listed already). It names the path, its
// HEAD, a thread that works in it and the way out. nil otherwise, and when the worktree
// there has branch checked out (memberWorktree shares it).
func (m *Manager) defaultPathTaken(r project.Project, branch string, onDisk bool) error {
	want := m.opts.Projects.DefaultWorktreePath(r.ID, branch)
	if want == "" {
		return nil
	}
	name := cmp.Or(r.Name, r.ID)
	i := slices.IndexFunc(r.Worktrees, func(w project.Worktree) bool { return samePath(w.Path, want) })
	holder := func() string {
		if t, ok := m.otherHolder("", want); ok {
			return "; thread " + holderLabel(t) + " works in it"
		}
		return ""
	}
	switch {
	case i >= 0 && !r.Worktrees[i].Detached && r.Worktrees[i].Branch == branch:
		return nil
	case i >= 0:
		w := r.Worktrees[i]
		head := w.Branch
		if w.Detached || head == "" {
			head = "a detached HEAD at " + w.Head[:min(7, len(w.Head))]
		}
		return fmt.Errorf("%w: %s's worktree for %s at %s has %s checked out now%s; switch it back to %s, or pick another branch",
			ErrFailedPrecondition, name, branch, w.Path, head, holder(), branch) // the path as git lists it
	case onDisk && pathExists(filepath.Join(want, ".git")):
		return fmt.Errorf("%w: %s's worktree for %s would go to %s, which holds a git checkout %s does not list on %s%s; move it away, or pick another branch",
			ErrFailedPrecondition, name, branch, want, name, branch, holder())
	}
	return nil
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
	// A main checkout on the branch refuses the lot before anything is made (fuzz
	// finding A7): the thread would need a second worktree on that branch. So does the
	// branch's default path holding a worktree switched to another branch: that is another
	// thread's checkout now, never shared as the branch's (thread-checkouts).
	for _, r := range projects {
		if _, ok := m.memberWorktree(r, branch); ok {
			continue
		}
		if cur, ok := m.opts.Projects.Snapshot().Project(r.ID); ok {
			r = cur
		}
		if err := mainCheckoutBusy(r, branch); err != nil {
			errs = append(errs, err)
		} else if err := m.defaultPathTaken(r, branch, false); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
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
// fresh says the branch was new when the Create picked it. It pre-trusts the worktree
// for Claude. Two threads making the same (project, branch) wait for each other, and the
// second finds the first's: under the lock a fresh branch that exists now (another
// Create with the same --branch made it meanwhile) is no longer new, and its worktree is
// shared. The project's main checkout is never the thread's worktree (branchWorktree);
// makeWorktrees refuses a branch checked out there (mainCheckoutBusy).
func (m *Manager) makeWorktree(ctx context.Context, r project.Project, branch, base string, fresh, fromOrigin bool) (madeWorktree, bool, error) {
	unlock := m.lockWorktree(r.ID, branch)
	defer unlock()
	if fresh && m.opts.RefExists(ctx, r.Path, "refs/heads/"+branch) {
		m.log.Info("new branch was made meanwhile by another create; sharing it", "project", r.ID, "branch", branch)
		fresh = false
	}
	if _, ok := m.memberWorktree(r, branch); ok && !fresh {
		return madeWorktree{}, false, nil // a new branch has no worktree yet
	}
	cur := r
	if p, ok := m.opts.Projects.Snapshot().Project(r.ID); ok {
		cur = p
	}
	if err := m.defaultPathTaken(cur, branch, true); err != nil {
		return madeWorktree{}, false, err
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
	return madeWorktree{projectID: r.ID, projectName: r.Name, path: filepath.Clean(wt.Path), newBranch: newBranch, startPoint: wt.StartPoint, worktree: wt}, true, nil
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

// ensureMembers makes s's other members' checkouts whole before it starts and returns
// the worktrees it made, and a timeline note for each checkout it replaced. In worktree
// mode a missing worktree (a cleanup or a hand removed it, or none was recorded) is made
// again on the thread's branch, in parallel; a member with none recorded gets the
// checkout the creation rule gives (resolveMember). A recorded checkout the app cannot
// make again (checkout mode: a user's worktree the thread ran in and left with Run in,
// since deleted) falls back to the member's own checkout, said in the note: the project
// set never changes, so the thread could not start otherwise. What it made or resolved is
// recorded on the thread (persisted with the start's next save), so the checkout stays the
// thread's when its branch moves. The primary's is recreate.go's (ensureWorktree).
func (m *Manager) ensureMembers(ctx context.Context, s Thread) ([]madeWorktree, []string, error) {
	if m.opts.Projects == nil || len(s.Projects()) == 0 {
		return nil, nil, nil
	}
	snap := m.opts.Projects.Snapshot()
	found := map[string]string{}
	var todo []project.Project
	var notes []string
	for _, c := range m.checkouts(s) {
		if c.Primary || !c.Registered {
			continue
		}
		switch {
		case c.WorktreeMode && c.Missing:
			if r, ok := snap.Project(c.ProjectID); ok {
				todo = append(todo, r)
			}
		case !c.Recorded && !c.Missing:
			found[c.ProjectID] = c.Path
		case c.Recorded && c.Missing:
			r, ok := snap.Project(c.ProjectID)
			if !ok {
				continue
			}
			own := resolveMember(s, r, m.opts.Projects.DefaultWorktreePath)
			if own == "" || samePath(own, c.Path) || !isDir(own) {
				continue // nothing else to run in: requireCheckouts names the missing one
			}
			m.log.Info("member checkout of thread is gone; using the project's own checkout", "thread", s.ID, "project", c.ProjectID, "was", c.Path, "now", own)
			found[c.ProjectID] = own
			notes = append(notes, fallbackNote(cmp.Or(c.ProjectName, c.ProjectID), c.Path, own))
		}
	}
	var made []madeWorktree
	if len(todo) > 0 {
		m.update(s.ID, false, func(*record) {}) // STARTING now: the fetches may take seconds
		m.log.Info("member worktrees of thread are gone; making them again", "thread", s.ID, "projects", len(todo), "branch", s.Branch)
		var err error
		if made, err = m.makeWorktrees(ctx, todo, s.Branch, func(string) string { return "" }, false, m.opts.BaseFromOrigin()); err != nil {
			return nil, nil, err
		}
		for _, r := range todo {
			path := ""
			if i := slices.IndexFunc(made, func(w madeWorktree) bool { return w.projectID == r.ID }); i >= 0 {
				path = made[i].path
			} else if wt, ok := m.memberWorktree(r, s.Branch); ok {
				path = wt.Path // another start made it meanwhile
			}
			if was, _ := s.CheckoutPath(r.ID); path != "" && was != "" && !samePath(was, path) {
				m.log.Info("member worktree made again at another path", "thread", s.ID, "project", r.ID, "was", was, "now", path)
			}
			found[r.ID] = path
		}
	}
	for i := range made {
		if made[i].newBranch && made[i].startPoint == "" {
			// The branch was gone there too: name the base it was made from in the note.
			if r, ok := snap.Project(made[i].projectID); ok {
				made[i].startPoint = cmp.Or(made[i].worktree.Status.BaseRef, "origin/"+cmp.Or(r.DefaultBranch, "main"))
			}
		}
	}
	if len(found) > 0 {
		m.update(s.ID, false, func(r *record) {
			for id, path := range found {
				if path != "" {
					r.s = r.s.withCheckout(id, path)
				}
			}
			if r.s.ProjectID != "" {
				r.s = r.s.withCheckout(r.s.ProjectID, r.s.WorktreePath)
			}
		})
	}
	return made, notes, nil
}

// fallbackNote is the timeline line for a member whose recorded checkout is gone and
// that now works in the project's own checkout (ensureMembers).
func fallbackNote(project, was, now string) string {
	return "The checkout of project " + project + " this thread worked in (" + was + ") no longer exists, so the thread now works in " +
		project + "'s own checkout (" + now + "). Commits on its branch are still in the repository; files that were only in that folder are gone."
}
