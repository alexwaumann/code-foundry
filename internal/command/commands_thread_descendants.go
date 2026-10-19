package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A thread's subtree (docs/notes/orch-descendants.md): thread.list, thread.reports and
// thread.archive take descendants-of, the thread whose tree to act on. The daemon
// selects it (ThreadFilter.descendants_of: tree order, Thread.depth, totals), so it
// composes with the other filters; created-by stays one level. The list and the
// reports indent each row two spaces per level under the root, with "↳ " before the
// name of a thread below it, and add each thread's cost and a total line. Archive acts
// on the threads below the root (the root too with include-root) and always confirms:
// the caller has not seen the ids.

// descendantsArg is the descendants-of arg of thread.list, thread.reports and
// thread.archive, with what it does there.
func descendantsArg(what string) ArgSpec {
	return ArgSpec{Name: "descendants-of", Type: String, ID: ThreadID,
		Description: "A thread (id or suffix): " + what + ", up to 8 levels down; composes with the other filters"}
}

// includeRootArg is thread.archive's include-root.
var includeRootArg = ArgSpec{Name: "include-root", Type: Bool, Description: "With descendants-of: archive that thread too"}

// subtreeName is a row's name indented for its depth: "Lead" at 0, "↳ Lead" at 1,
// "  ↳ Worker" at 2.
func subtreeName(name string, depth int32) string {
	if depth <= 0 {
		return name
	}
	return strings.Repeat("  ", int(depth-1)) + "↳ " + name
}

// subtreeTotal is the total line under a subtree: "total: 3 threads, $0.04".
func subtreeTotal(n int, cost float64) string {
	return fmt.Sprintf("total: %s, %s", plural(n, "thread"), formatUSD(cost))
}

// subtreeTargets are the threads thread.archive with descendants-of acts on: those of
// root's subtree whose archived state differs from archived's, without root unless
// includeRoot. The list includes archived threads (to unarchive them) and never the
// plugins' (as thread.list). rootName is root's name, else its id.
func subtreeTargets(ctx context.Context, b ThreadBackend, root string, archived, includeRoot bool) (targets []*v1.Thread, rootName string, err error) {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{IncludeArchived: true, DescendantsOf: root}}))
	if err != nil {
		return nil, "", err
	}
	rootName = root
	for _, s := range res.Msg.GetThreads() {
		if s.GetId() == root {
			rootName = threadNameOrID(s)
			if !includeRoot {
				continue
			}
		}
		if (s.GetArchivedAt() != nil) != archived {
			targets = append(targets, s)
		}
	}
	return targets, rootName, nil
}

// archiveTarget is the archived value thread.archive sets with ids or descendants-of:
// archive unless archived=false.
func archiveTarget(a Args) bool { return !a.Has("archived") || a.Bool("archived") }

// archiveSubtree is thread.archive with descendants-of.
func archiveSubtree(ctx context.Context, b ThreadBackend, a Args) (Result, error) {
	archived := archiveTarget(a)
	targets, rootName, err := subtreeTargets(ctx, b, a.String("descendants-of"), archived, a.Bool("include-root"))
	if err != nil {
		return Result{}, err
	}
	if len(targets) == 0 {
		what := "to archive"
		if !archived {
			what = "to unarchive"
		}
		return Result{Message: "no threads under " + rootName + " " + what, JSON: ThreadsResult{Done: []string{}, Failed: []ThreadFailure{}}}, nil
	}
	ids := make([]string, len(targets))
	for i, s := range targets {
		ids[i] = s.GetId()
	}
	return archiveThreads(ctx, b, ids, a), nil
}

// archiveSubtreeConfirm is thread.archive's confirmation with descendants-of: always
// when archiving something, with the count, the root and the ids, and the busy ones as
// archiveManyConfirm says them; "" when unarchiving or when nothing is to archive (Run
// says so).
func archiveSubtreeConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	if !archiveTarget(a) {
		return ""
	}
	targets, rootName, err := subtreeTargets(ctx, b, a.String("descendants-of"), true, a.Bool("include-root"))
	if err != nil || len(targets) == 0 {
		return ""
	}
	return subtreeConfirmText(targets, rootName, a.Bool("include-root"))
}

// subtreeConfirmText is archiveSubtreeConfirm's text for targets under rootName:
// "Archive 3 threads under Lead B (Lead B too)? They are closed and listed apart: a, b,
// c." and, when some are busy, which and what archiving ends.
func subtreeConfirmText(targets []*v1.Thread, rootName string, includeRoot bool) string {
	ids := make([]string, len(targets))
	var busy []string
	for i, s := range targets {
		ids[i] = s.GetId()
		if why, _ := archiveInterrupts(s); why != "" {
			busy = append(busy, threadNameOrID(s)+" ("+why+")")
		}
	}
	where := "under " + rootName
	if includeRoot {
		where += " (" + rootName + " too)"
	}
	msg := fmt.Sprintf("Archive %s %s? They are closed and listed apart: %s.", plural(len(targets), "thread"), where, listSome(ids))
	if len(targets) == 1 {
		msg = fmt.Sprintf("Archive 1 thread %s? It is closed and listed apart: %s.", where, ids[0])
	}
	switch len(busy) {
	case 0:
		return msg
	case 1:
		return msg + " 1 of them is busy: " + busy[0] + "; archiving ends its turn or stops its background work."
	}
	return msg + fmt.Sprintf(" %d of them are busy: %s; archiving ends their turns and stops their background work.", len(busy), listSome(busy))
}
