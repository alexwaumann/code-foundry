package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Several threads at once (docs/notes/agent-cli-feedback-2.md): thread.remove and
// thread.archive take ids, a comma-separated list, besides id. Each entry resolves like
// any thread id (an IDList arg, resolve.go) before anything runs, so a typo acts on
// none; then the backend call runs per thread, past one that fails, and the result
// names the failures and exits 1. There are no label or creator selectors on these
// destructive commands: a caller lists the ids first (thread.reports, thread.list
// --json) and passes them.

// threadIDsArg is the ids arg of thread.remove and thread.archive.
var threadIDsArg = ArgSpec{Name: "ids", Type: String, ID: ThreadID, IDList: true,
	Description: "Comma-separated thread ids (or suffixes), to act on several instead of id; exit 1 if one fails"}

// optionalID is idArg for a command that also takes ids: not required, since ids
// stands in for it. Run checks one of them is given (targetThreads).
func optionalID(idArg ArgSpec) ArgSpec {
	idArg.Required = false
	return idArg
}

// hasThreadOrCLI is the availability of a command that takes ids: the GUI needs a
// thread in view; a CLI caller (no active view) may name its threads with ids alone,
// which When cannot see, so Run validates instead (like canStartThread).
func hasThreadOrCLI(c Context) bool { return hasThread(c) || c.ActiveView == "" }

// targetThreads are the threads a command with ids acts on: ids' entries when given
// (id is then ignored: in a thread it is only the context default, the caller's own
// thread), else id alone. Neither is an *ArgError.
func targetThreads(a Args) ([]string, error) {
	if ids := splitList(a.String("ids")); len(ids) > 0 {
		return ids, nil
	}
	if id := a.String("id"); id != "" {
		return []string{id}, nil
	}
	return nil, InvalidArg("id", "missing required argument %q (or ids, for several threads)", "id")
}

// notSelf refuses a CLI call of thread.remove or thread.archive (verb) whose thread is
// only the context default: inside a thread that is the caller's own thread
// ($CODE_FOUNDRY_THREAD), which an agent rarely means to archive or forget (an empty
// "$CHILD" it meant to pass, or a forgotten --id). An explicit id, ids or
// descendants-of, and every GUI call (whose context thread is the one in view), pass.
func notSelf(c Context, a Args, verb string) error {
	if c.ActiveView != "" || a.Given("id") || a.Has("ids") || a.String("descendants-of") != "" || !a.Has("id") {
		return nil
	}
	id := a.String("id")
	return InvalidArg("id", "not %s the thread this runs in (%s) without --id; pass --id %s to mean it", verb, id, id)
}

// ThreadsResult is the --json answer of thread.remove and thread.archive given ids:
// the threads done, and those that failed with why.
type ThreadsResult struct {
	Done   []string        `json:"done"`
	Failed []ThreadFailure `json:"failed"`
}

// ThreadFailure is one thread a command given ids could not act on.
type ThreadFailure struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

// eachThread runs do for every id, past failures, and reports them: "<verb> 3 threads:
// a, b, c", then "failed on 1 thread:" and one "  <id>: <error>" line each, exit 1.
func eachThread(ctx context.Context, ids []string, verb string, do func(ctx context.Context, id string) error) Result {
	res := ThreadsResult{Done: []string{}, Failed: []ThreadFailure{}}
	for _, id := range ids {
		if err := do(ctx, id); err != nil {
			res.Failed = append(res.Failed, ThreadFailure{ID: id, Error: err.Error()})
			continue
		}
		res.Done = append(res.Done, id)
	}
	var lines []string
	if len(res.Done) > 0 {
		lines = append(lines, verb+" "+plural(len(res.Done), "thread")+": "+strings.Join(res.Done, ", "))
	}
	if len(res.Failed) == 0 {
		return Result{Message: strings.Join(lines, "\n"), JSON: res}
	}
	lines = append(lines, "failed on "+plural(len(res.Failed), "thread")+":")
	for _, f := range res.Failed {
		lines = append(lines, "  "+f.ID+": "+f.Error)
	}
	return Result{Message: strings.Join(lines, "\n"), JSON: res, ExitCode: 1}
}

// confirmListMax is how many ids a confirmation lists before "and N more".
const confirmListMax = 10

// listSome is items joined by ", ", the first confirmListMax of them and "and N more".
func listSome(items []string) string {
	if len(items) <= confirmListMax {
		return strings.Join(items, ", ")
	}
	return strings.Join(items[:confirmListMax], ", ") + fmt.Sprintf(" and %d more", len(items)-confirmListMax)
}

// removeConfirm is thread.remove's confirmation: of the one thread, or of several
// given ids; "" without a target (Run says what is missing). When one of them has
// worktrees Code Foundry made (madeWorktrees), it says the daemon removes the clean ones
// (docs/notes/remove-cleans-worktrees.md). It names the hidden child threads of the
// removed ones still working (orphanedWorking): they keep running and the daemon shows
// them in the sidebar.
func removeConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	ids, err := targetThreads(a)
	var ask string
	switch {
	case err != nil || len(ids) == 0:
		return ""
	case len(ids) == 1:
		ask = "Remove thread " + ids[0] + "? Claude stops if it runs, and the thread is forgotten."
		if madeWorktrees(ctx, b, ids) {
			ask += " Its clean worktrees are removed; branches stay."
		}
	default:
		ask = fmt.Sprintf("Remove %d threads? Claude stops in each that runs, and they are forgotten: %s.", len(ids), listSome(ids))
		if madeWorktrees(ctx, b, ids) {
			ask += " Their clean worktrees are removed; branches stay."
		}
	}
	if clause := removedAlongText(removedAlong(ctx, b, ids)); clause != "" {
		ask += " " + clause
	}
	return ask
}

// madeWorktrees reports whether one of ids is a worktree-mode thread (created_worktree
// on a branch): its worktree-mode worktrees are Code Foundry's, and the daemon removes the
// clean ones after the removal. A thread in place or in a folder has none. False when the
// list fails.
func madeWorktrees(ctx context.Context, b ThreadBackend, ids []string) bool {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}))
	if err != nil {
		return false
	}
	return slices.ContainsFunc(res.Msg.GetThreads(), func(s *v1.Thread) bool {
		return s.GetCreatedWorktree() && s.GetBranch() != "" && slices.Contains(ids, s.GetId())
	})
}

// removedAlong counts the hidden threads below ids that removing them takes along
// (ThreadFilter.archive_cascade_of, the archive cascade's list: removing cascades the
// same way), each once and not among ids, and how many of those are mid-turn
// (hiddenWorking). An id the daemon does not know has none (Run reports it).
func removedAlong(ctx context.Context, b ThreadBackend, ids []string) (hidden, working int) {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		seen[id] = true
	}
	for _, id := range ids {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{ArchiveCascadeOf: id, IncludeArchived: true}}))
		if err != nil {
			continue
		}
		for _, s := range res.Msg.GetThreads() {
			if seen[s.GetId()] {
				continue
			}
			seen[s.GetId()] = true
			hidden++
			if midTurn(s) != "" {
				working++
			}
		}
	}
	return hidden, working
}

// removedAlongText is the clause thread.remove adds for the hidden child threads it
// removes along (hidden, of which working are mid-turn): removal forgets them too, so
// they are named even when idle, and how to keep one.
func removedAlongText(hidden, working int) string {
	if hidden == 0 {
		return ""
	}
	what := fmt.Sprintf("%d hidden child threads below it are", hidden)
	if hidden == 1 {
		what = "1 hidden child thread below it is"
	}
	switch {
	case working == 0:
	case working == hidden && hidden == 1:
		what += " still working, and is"
	case working == hidden:
		what += " still working, and are"
	default:
		what += fmt.Sprintf(" (%d still working)", working)
	}
	keep := "To keep one, show it in the sidebar first."
	if hidden == 1 {
		keep = "To keep it, show it in the sidebar first."
	}
	return what + " removed too. " + keep
}

// removeThreads is thread.remove given ids.
func removeThreads(ctx context.Context, b ThreadBackend, ids []string) Result {
	return eachThread(ctx, ids, "removed", func(ctx context.Context, id string) error {
		_, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveThreadRequest{Id: id}))
		return err
	})
}

// archiveThreads is thread.archive given ids: it archives each (archived=false
// unarchives each); unlike one id it does not toggle, since a list may mix both.
func archiveThreads(ctx context.Context, b ThreadBackend, ids []string, a Args) Result {
	archived := archiveTarget(a)
	verb := "archived"
	if !archived {
		verb = "unarchived"
	}
	return eachThread(ctx, ids, verb, func(ctx context.Context, id string) error {
		_, err := b.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: id, Archived: archived}))
		return err
	})
}

// archiveManyConfirm is thread.archive's confirmation given ids, or "" when it needs
// none: unarchiving, or no thread among them mid-turn or running background work
// (archiveInterrupts, the rule for one thread). It reads them in one list; a thread
// not in it needs none (Run reports it).
func archiveManyConfirm(ctx context.Context, b ThreadBackend, ids []string, a Args) string {
	if a.Has("archived") && !a.Bool("archived") {
		return ""
	}
	res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}))
	if err != nil {
		return ""
	}
	byID := make(map[string]*v1.Thread, len(res.Msg.GetThreads()))
	for _, s := range res.Msg.GetThreads() {
		byID[s.GetId()] = s
	}
	if len(ids) == 1 {
		if s, ok := byID[ids[0]]; ok {
			return archiveOneConfirm(ctx, b, s)
		}
		return ""
	}
	var busy []string
	for _, id := range ids {
		s, ok := byID[id]
		if !ok {
			continue
		}
		if why, _ := archiveInterrupts(s); why != "" {
			busy = append(busy, threadNameOrID(s)+" ("+why+")")
		}
	}
	var msg string
	switch len(busy) {
	case 0:
	case 1:
		msg = fmt.Sprintf("Archive %d threads? 1 of them is busy: %s. Archiving ends its turn or stops its background work.", len(ids), busy[0])
	default:
		msg = fmt.Sprintf("Archive %d threads? %d of them are busy: %s. Archiving ends their turns and stops their background work.",
			len(ids), len(busy), listSome(busy))
	}
	if kids := hiddenWorking(ctx, b, ids); len(kids) > 0 {
		if msg == "" {
			msg = fmt.Sprintf("Archive %d threads?", len(ids))
		}
		msg += " " + hiddenWorkingText(len(kids), "")
	}
	return msg
}

// threadNameOrID is s's name, else its id.
func threadNameOrID(s *v1.Thread) string {
	if s.GetName() != "" {
		return s.GetName()
	}
	return s.GetId()
}
