package ember

import (
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A task's team (docs/notes/ember-fixes-1-gui.md): the threads below its worker thread
// (those it created, those they created, and so on), so a lead's workers show on the
// board, count in "N threads working" and bring a worker's prompt to Ember's row. Derived
// for open tasks only (todo, doing, blocked): a finished task's team does not change the
// board, and leaving it out keeps their activity from republishing it.

// MaxTeamList is how many of a team's threads Team.Members lists.
const MaxTeamList = 10

// Team is the threads below a task's worker thread that are not archived.
type Team struct {
	// Working: on a turn, starting, or themselves waiting on their own child threads.
	Working int
	// Waiting: waiting on the user, a pending permission request or question.
	Waiting int
	// Total counts every one of them.
	Total int
	// Members are the first MaxTeamList in tree order (thread.Subtree: each thread
	// before the threads it created, siblings oldest first).
	Members []TeamMember
}

// TeamMember is one thread of a team as the board shows it.
type TeamMember struct {
	ID             string
	Name           string
	State          thread.State
	Status         thread.Status
	StatusReason   string
	Report         thread.Report
	LastActivityAt time.Time
	// Depth is how far below the task's thread it is (1: a thread that one created).
	Depth int
}

// teamIndex is the threads of one snapshot, by id, and their lineage, built once per
// publish for every task's team.
type teamIndex struct {
	byID  map[string]thread.Thread
	nodes []thread.LineageNode
}

func newTeamIndex(threads *thread.Snapshot) *teamIndex {
	ix := &teamIndex{byID: map[string]thread.Thread{}}
	if threads == nil {
		return ix
	}
	ix.nodes = make([]thread.LineageNode, 0, len(threads.Threads))
	for _, t := range threads.Threads {
		ix.byID[t.ID] = t
		ix.nodes = append(ix.nodes, thread.LineageNode{ID: t.ID, CreatedBy: t.CreatedBy, CreatedAt: t.CreatedAt})
	}
	return ix
}

// team is the team below thread root.
func (ix *teamIndex) team(root string) Team {
	var out Team
	for _, e := range thread.Subtree(ix.nodes, root) {
		t, ok := ix.byID[e.ID]
		if e.Depth == 0 || !ok || !t.ArchivedAt.IsZero() {
			continue
		}
		out.Total++
		switch {
		case waitsOnUser(t):
			out.Waiting++
		case working(t):
			out.Working++
		}
		if len(out.Members) < MaxTeamList {
			out.Members = append(out.Members, TeamMember{
				ID: t.ID, Name: t.Name, State: t.State, Status: t.Status, StatusReason: t.StatusReason, Report: t.Report,
				LastActivityAt: t.LastActivityAt, Depth: e.Depth,
			})
		}
	}
	return out
}

// working reports whether t is working for the board: on a turn, starting, or waiting
// on its own child threads (a lead whose workers run).
func working(t thread.Thread) bool {
	return t.Status == thread.StatusBusy || t.State == thread.StateStarting ||
		t.Status == thread.StatusIdle && thread.IsWaitingReason(t.StatusReason)
}

// waitsOnUser reports whether t waits on the user's answer: a pending permission
// request or question while its process runs (a stopped thread keeps the reason of a
// request that ended with it).
func waitsOnUser(t thread.Thread) bool {
	if t.Status != thread.StatusNeedsAttention || t.State == thread.StateDisconnected || t.State == thread.StateClosing {
		return false
	}
	return strings.HasPrefix(t.StatusReason, "permission:") || strings.HasPrefix(t.StatusReason, "question:")
}
