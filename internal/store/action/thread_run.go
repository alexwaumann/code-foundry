package action

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// A run a thread owns (docs/notes/thread-project-set.md): the action may belong to any
// project of the thread's set, and runs in the thread's checkout of that project, with
// the thread as its owner (its bottom panel, its run records). Before, only the cwd's
// project's actions ran for a thread; another member's ran as a worktree's run the
// thread never saw.

// threadRun resolves the action ref names for thread threadID and the run's owner. With
// projectID the action is that member's; else an id names any member's action, and a
// name is looked up in the cwd's project first, then in the other members (it must be
// one action).
func (m *Manager) threadRun(threadID, projectID, ref string) (Action, Owner, error) {
	if m.opts.Thread == nil {
		return Action{}, Owner{}, fmt.Errorf("%w: thread %s", ErrNotFound, threadID)
	}
	place, ok := m.opts.Thread(threadID)
	if !ok {
		return Action{}, Owner{}, fmt.Errorf("%w: thread %s", ErrNotFound, threadID)
	}
	members := maps.Clone(place.Checkouts)
	if members == nil {
		members = map[string]string{}
	}
	if place.ProjectID != "" {
		members[place.ProjectID] = place.Worktree
	}
	if len(members) == 0 {
		return Action{}, Owner{}, fmt.Errorf("%w: thread %s has no project; actions belong to a project", ErrFailedPrecondition, threadID)
	}
	snap := m.Snapshot()
	var a Action
	var err error
	if projectID != "" {
		if _, ok := members[projectID]; !ok {
			return Action{}, Owner{}, fmt.Errorf("%w: project %s is not one of thread %s's projects (%s)", ErrInvalidArgument, projectID, threadID, idList(members))
		}
		a, err = snap.Resolve(projectID, ref)
	} else {
		a, err = resolveForThread(snap, place.ProjectID, members, threadID, ref, m.projectName)
	}
	if err != nil {
		return Action{}, Owner{}, err
	}
	path := members[a.ProjectID]
	if path == "" {
		return Action{}, Owner{}, fmt.Errorf("%w: thread %s has no checkout of project %s yet (it is made at the thread's next start)", ErrFailedPrecondition, threadID, a.ProjectID)
	}
	return a, Owner{ThreadID: threadID, ProjectID: a.ProjectID, Worktree: path}, nil
}

// resolveForThread is ref among the actions of members (project id → checkout): an id
// of any member's action, else a name in cwdProject first, then in exactly one other
// member. name gives a project's name for the messages. Pure.
func resolveForThread(snap *Snapshot, cwdProject string, members map[string]string, threadID, ref string, name func(string) string) (Action, error) {
	ref = strings.TrimSpace(ref)
	if a, ok := snap.Action(ref); ok {
		if _, member := members[a.ProjectID]; !member {
			return Action{}, &resolveError{kind: ErrFailedPrecondition, msg: "action " + a.Name + " (" + a.ID + ") belongs to project " + name(a.ProjectID) +
				", which is not one of thread " + threadID + "'s projects"}
		}
		return a, nil
	}
	if cwdProject != "" {
		if a, err := snap.Resolve(cwdProject, ref); err == nil || ref == "" {
			return a, err
		}
	} else if ref == "" {
		return snap.Resolve("", ref)
	}
	var found []Action
	for _, pid := range slices.Sorted(maps.Keys(members)) {
		if pid == cwdProject {
			continue
		}
		for _, a := range snap.ForProject(pid) {
			if strings.EqualFold(a.Name, ref) {
				found = append(found, a)
			}
		}
	}
	switch len(found) {
	case 0:
		return Action{}, &resolveError{kind: ErrNotFound, msg: "no action " + quote(ref) + " in thread " + threadID + "'s projects"}
	case 1:
		return found[0], nil
	}
	ids := make([]string, len(found))
	for i, a := range found {
		ids[i] = a.ID + " (" + name(a.ProjectID) + ")"
	}
	return Action{}, &resolveError{kind: ErrInvalidArgument, msg: "action " + quote(ref) + " is in several of thread " + threadID +
		"'s projects: " + strings.Join(ids, ", ") + "; pass its id"}
}

// projectName is the registered project's name, else its id.
func (m *Manager) projectName(id string) string {
	if r, ok := m.opts.Projects.Snapshot().Project(id); ok && r.Name != "" {
		return r.Name
	}
	return id
}

func idList(m map[string]string) string { return strings.Join(slices.Sorted(maps.Keys(m)), ", ") }
