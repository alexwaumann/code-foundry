package thread

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// PlacementOutcome is what a Create would do with one project of a new thread.
type PlacementOutcome int

const (
	// PlacementNew: a new worktree would be made, at Path (empty while the branch is
	// named at the Create).
	PlacementNew PlacementOutcome = iota + 1
	// PlacementShare: the thread would work in an existing checkout at Path, on Branch:
	// the branch's worktree another thread may already use, or in checkout mode the
	// project's own checkout.
	PlacementShare
	// PlacementFolder: a plain folder (no git); threads run in it.
	PlacementFolder
	// PlacementRefused: the Create would be refused; Message is its error.
	PlacementRefused
)

func (o PlacementOutcome) String() string {
	switch o {
	case PlacementNew:
		return "new"
	case PlacementShare:
		return "share"
	case PlacementFolder:
		return "folder"
	case PlacementRefused:
		return "refused"
	default:
		return "unknown"
	}
}

// PlacementCheck asks where a new thread would go: its projects (refs, as
// CreateOptions.ProjectIDs, "<ref>[:<base>]"), the branch a new worktree asks for (as
// NewWorktree.Branch; "" when the Create names it) and checkout mode (in place).
type PlacementCheck struct {
	ProjectIDs   []string
	Branch       string
	CheckoutMode bool
}

// MemberPlacement is the outcome for one project.
type MemberPlacement struct {
	ProjectID, ProjectName string
	Outcome                PlacementOutcome
	// Path and Branch are the checkout and its branch (HEAD) for share, the new
	// worktree's path and branch for new, the folder for folder.
	Path, Branch string
	// Message is the Create's refusal (refused only).
	Message string
}

// PlacementReport is CheckPlacement's answer.
type PlacementReport struct {
	// Branch is the branch a worktree-mode Create would use; "" in checkout mode and
	// when the namer picks it at the Create (BranchNamedAtCreate).
	Branch              string
	BranchNamedAtCreate bool
	// Members are in project id order.
	Members []MemberPlacement
}

// CheckPlacement reports where a new thread with c would go, per project, without
// making or changing anything: the composer's Work in picker and the card's Run in
// menu show it before a send. It resolves the projects and the branch with the
// Create's own code (placeRequest, newBranchChoice, existingBranchChoice) and decides
// each git member with worktreeFor, which makeWorktrees runs before it makes anything,
// so the check and the Create never disagree. Like and creator inheritance are not
// considered: the check is for an explicit set. An invalid request (an unknown project,
// one listed twice, a bad branch) is the error.
func (m *Manager) CheckPlacement(ctx context.Context, c PlacementCheck) (PlacementReport, error) {
	var rep PlacementReport
	if m.opts.Projects == nil {
		return rep, fmt.Errorf("%w: placement needs the project store", ErrFailedPrecondition)
	}
	o := CreateOptions{ProjectIDs: c.ProjectIDs, CheckoutMode: c.CheckoutMode}
	if !c.CheckoutMode {
		o.NewWorktree = &NewWorktree{Branch: c.Branch}
	}
	req, _, err := m.placeRequest(o)
	if err != nil {
		return rep, err
	}
	if len(req.projectIDs) == 0 {
		return rep, fmt.Errorf("%w: a project is required", ErrInvalidArgument)
	}
	snap := m.opts.Projects.Snapshot()
	var git, plain []project.Project
	for _, id := range CleanProjectIDs("", req.projectIDs) {
		r, err := m.projectByRef(snap, id)
		if err != nil {
			return rep, err
		}
		if r.Git {
			git = append(git, r)
		} else {
			plain = append(plain, r)
		}
	}
	member := func(r project.Project) MemberPlacement {
		return MemberPlacement{ProjectID: r.ID, ProjectName: cmp.Or(r.Name, r.ID)}
	}
	if c.CheckoutMode {
		for _, r := range append(git, plain...) {
			mp := member(r)
			mp.Outcome, mp.Path = PlacementShare, mainCheckout(r)
			if !r.Git {
				mp.Outcome = PlacementFolder
			} else if w, ok := snap.Worktree(r.ID, mp.Path); ok && !w.Detached {
				mp.Branch = w.Branch
			}
			rep.Members = append(rep.Members, mp)
		}
		sortMembers(rep.Members)
		return rep, nil
	}
	if len(git) == 0 {
		// placeWorktrees' refusal: a set of plain folders has nothing to put in a worktree.
		// It names the primary, the first project given.
		first, _ := m.projectByRef(snap, req.projectIDs[0])
		msg := noGitForWorktree(first).Error()
		for _, r := range plain {
			mp := member(r)
			mp.Outcome, mp.Message = PlacementRefused, msg
			rep.Members = append(rep.Members, mp)
		}
		sortMembers(rep.Members)
		return rep, nil
	}
	bc, err := m.newBranchChoice(c.Branch)
	if err != nil {
		return rep, err
	}
	paths := make([]string, len(git))
	for i, r := range git {
		paths[i] = r.Path
	}
	bc = m.existingBranchChoice(ctx, paths, bc, c.Branch)
	branch, known := knownBranch(bc)
	rep.Branch, rep.BranchNamedAtCreate = branch, !known
	for _, r := range plain {
		mp := member(r)
		mp.Outcome, mp.Path = PlacementFolder, mainCheckout(r)
		rep.Members = append(rep.Members, mp)
	}
	for _, r := range git {
		mp := member(r)
		if !known {
			mp.Outcome = PlacementNew // the path follows the branch the namer picks
			rep.Members = append(rep.Members, mp)
			continue
		}
		wt, existing, err := m.worktreeFor(r, branch, true)
		switch {
		case err != nil:
			mp.Outcome, mp.Message = PlacementRefused, err.Error()
		case existing:
			mp.Outcome, mp.Path, mp.Branch = PlacementShare, wt.Path, wt.Branch
		default:
			mp.Outcome, mp.Path, mp.Branch = PlacementNew, m.opts.Projects.DefaultWorktreePath(r.ID, branch), branch
		}
		rep.Members = append(rep.Members, mp)
	}
	sortMembers(rep.Members)
	return rep, nil
}

func sortMembers(ms []MemberPlacement) {
	slices.SortFunc(ms, func(a, b MemberPlacement) int { return strings.Compare(a.ProjectID, b.ProjectID) })
}

// knownBranch is the branch a Create with bc uses when it is decided without the namer:
// a verbatim one (with a slash, or an existing branch's name), or a prefix-mode slug
// the user gave (composeBranch with no reply, as waitNaming does when the branch needs
// no model). ok false: the namer picks it (or the cf/<id> fallback).
func knownBranch(bc branchChoice) (string, bool) {
	if bc.verbatim != "" {
		return bc.verbatim, true
	}
	if bc.hint != "" && bc.branchRequest() == nil {
		if b := composeBranch(bc.cfg, bc.hint, "", ""); b != "" {
			return b, true
		}
	}
	return "", false
}

// worktreeFor decides r's worktree for branch the way makeWorktrees does before it makes
// anything: the branch's existing worktree (memberWorktree; existing), else the refusal
// (the main checkout has the branch: mainCheckoutBusy; the default path holds another
// checkout: defaultPathTaken, with onDisk also a git checkout there r does not list),
// else none (a new one would go to the default path). CheckPlacement uses it too, so the
// check and the Create agree.
func (m *Manager) worktreeFor(r project.Project, branch string, onDisk bool) (project.Worktree, bool, error) {
	if wt, ok := m.memberWorktree(r, branch); ok {
		return wt, true, nil
	}
	if cur, ok := m.opts.Projects.Snapshot().Project(r.ID); ok {
		r = cur
	}
	if err := mainCheckoutBusy(r, branch); err != nil {
		return project.Worktree{}, false, err
	}
	if err := m.defaultPathTaken(r, branch, onDisk); err != nil {
		return project.Worktree{}, false, err
	}
	return project.Worktree{}, false, nil
}

// noGitForWorktree is placeWorktrees' refusal of a new worktree in a set without git.
func noGitForWorktree(plain project.Project) error {
	return fmt.Errorf("%w: %s is not a git repository; threads run in its current checkout", ErrFailedPrecondition, plain.Name)
}
