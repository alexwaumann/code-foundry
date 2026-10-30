package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// SetCheckouts makes Checkouts list cos for thread id (otherwise one checkout per
// project in its set at the path the thread records, the primary at its cwd, the others
// under /checkouts when none is recorded).
func (f *Fake) SetCheckouts(id string, cos []thread.Checkout) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.checkouts == nil {
		f.checkouts = map[string][]thread.Checkout{}
	}
	f.checkouts[id] = slices.Clone(cos)
}

// SetHints makes CheckoutHints return hints for every thread.
func (f *Fake) SetHints(hints ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hints = slices.Clone(hints)
}

// Checkouts records "Checkouts <id> <cwd>" and resolves the thread by id, else by the
// cwd (the thread whose cwd holds it).
func (f *Fake) Checkouts(_ context.Context, ref thread.CheckoutsRef) (thread.ThreadCheckouts, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, strings.TrimSpace("Checkouts "+ref.ID+" "+ref.Cwd))
	var s thread.Thread
	switch {
	case ref.ID != "":
		var err error
		if s, err = f.get(ref.ID); err != nil {
			return thread.ThreadCheckouts{}, err
		}
	case ref.Cwd != "":
		i := slices.IndexFunc(f.snap.Threads, func(t thread.Thread) bool {
			return t.WorktreePath != "" && (ref.Cwd == t.WorktreePath || strings.HasPrefix(ref.Cwd, t.WorktreePath+"/"))
		})
		if i < 0 {
			return thread.ThreadCheckouts{}, fmt.Errorf("%w: no thread has a checkout holding %s", thread.ErrNotFound, ref.Cwd)
		}
		s = f.snap.Threads[i]
	default:
		return thread.ThreadCheckouts{}, fmt.Errorf("%w: a thread id or a path is required", thread.ErrInvalidArgument)
	}
	cos, ok := f.checkouts[s.ID]
	if !ok {
		for _, pid := range s.Projects() {
			c := thread.Checkout{ProjectID: pid, ProjectName: pid, Registered: true, Git: true, Branch: s.Branch, Primary: pid == s.ProjectID,
				WorktreeMode: s.CreatedWorktree && s.Branch != "", Listed: true}
			if c.WorktreeMode {
				c.CreatedBranch = s.Branch
			}
			c.Path = "/checkouts/" + pid
			if p, ok := s.CheckoutPath(pid); ok {
				c.Path, c.Recorded = p, true
			}
			cos = append(cos, c)
		}
	}
	out := thread.ThreadCheckouts{Thread: s, Checkouts: slices.Clone(cos), WorkspaceID: s.WorkspaceID, Current: -1}
	for i, c := range out.Checkouts {
		if (ref.Cwd != "" && (ref.Cwd == c.Path || strings.HasPrefix(ref.Cwd, c.Path+"/"))) || (ref.Cwd == "" && c.Primary) {
			out.Current = i
		}
	}
	return out, nil
}

// CheckoutHints returns SetHints' hints.
func (f *Fake) CheckoutHints(thread.Thread) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.hints)
}

// SetPlacement makes CheckPlacement return rep.
func (f *Fake) SetPlacement(rep thread.PlacementReport) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.placement = &rep
}

// CheckPlacement records "CheckPlacement <ids> branch=<b> checkout=<bool>" and returns
// what SetPlacement gave, else a new worktree per project on c.Branch.
func (f *Fake) CheckPlacement(_ context.Context, c thread.PlacementCheck) (thread.PlacementReport, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf("CheckPlacement %s branch=%s checkout=%v", strings.Join(c.ProjectIDs, ","), c.Branch, c.CheckoutMode))
	if len(c.ProjectIDs) == 0 {
		return thread.PlacementReport{}, fmt.Errorf("%w: a project is required", thread.ErrInvalidArgument)
	}
	if f.placement != nil {
		return *f.placement, nil
	}
	rep := thread.PlacementReport{Branch: c.Branch, BranchNamedAtCreate: c.Branch == ""}
	for _, id := range c.ProjectIDs {
		rep.Members = append(rep.Members, thread.MemberPlacement{ProjectID: id, ProjectName: id, Outcome: thread.PlacementNew, Branch: c.Branch})
	}
	return rep, nil
}
