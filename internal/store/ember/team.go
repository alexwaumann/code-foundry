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
	// Working: on a turn, starting, or themselves waiting on their own child threads
	// (working).
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
		case working(t.State, t.Status, t.StatusReason):
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

// working reports whether a thread in state st with status and reason is working for
// the board: on a turn (busy while its process runs), starting, or waiting on its own
// child threads (a lead whose workers run: "waiting on 2 child threads"). Not working:
// a busy status left on a thread with no process (closing, stopped), and "waiting"
// alone, which names no child thread (only a wake queued to it, which a failed start
// may hold for a long time: wakebackoff.go). An idle worker is idle, whatever its task.
func working(st thread.State, status thread.Status, reason string) bool {
	switch {
	case st == thread.StateStarting:
		return true
	case status == thread.StatusIdle:
		n, ok := thread.WaitingOn(reason)
		return ok && n > 0
	}
	return status == thread.StatusBusy && st != thread.StateClosing && st != thread.StateDisconnected
}

// Working reports whether tt, a task's worker, works: itself (working) or a thread of
// its team. Archived and removed workers do not.
func (tt *TaskThread) Working() bool {
	if tt == nil || tt.Removed || tt.Archived {
		return false
	}
	return working(tt.State, tt.Status, tt.StatusReason) || tt.Team.Working > 0
}

// WaitsOnUser reports whether tt, or a thread of its team, waits on the user's answer.
func (tt *TaskThread) WaitsOnUser() bool {
	if tt == nil || tt.Removed || tt.Archived {
		return false
	}
	return askingUser(tt.State, tt.Status, tt.StatusReason) || tt.Team.Waiting > 0
}

// waitsOnUser reports whether t waits on the user's answer: a pending permission
// request or question while its process runs (a stopped thread keeps the reason of a
// request that ended with it).
func waitsOnUser(t thread.Thread) bool { return askingUser(t.State, t.Status, t.StatusReason) }

// askingUser is waitsOnUser over a thread's state, status and reason.
func askingUser(st thread.State, status thread.Status, reason string) bool {
	if status != thread.StatusNeedsAttention || st == thread.StateDisconnected || st == thread.StateClosing {
		return false
	}
	return strings.HasPrefix(reason, "permission:") || strings.HasPrefix(reason, "question:")
}
