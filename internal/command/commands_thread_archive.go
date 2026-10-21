package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadArchive is thread.archive: archive a thread (Claude closed, its shells
// removed, unpinned, listed apart) or unarchive it (back in the thread list, still
// disconnected). Without --archived it toggles. Archiving asks for confirmation only
// while Claude is working or waiting on the user's answer, since it ends that turn, or
// while the thread's background agents or shells run, since they stop with it, or
// while a hidden thread below it that the daemon archives with it is working or
// waiting (commands_thread_sidebar.go); idle, finished, errored and stopped threads
// archive at once, and unarchiving never asks (nor cascades).
// With ids it acts on several threads (commands_thread_bulk.go), with descendants-of on
// a thread's subtree (commands_thread_descendants.go).
// See docs/notes/archive-threads-1-daemon.md and docs/notes/thread-lifecycle.md.
func threadArchive(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.archive",
		Title: "Archive or Unarchive Thread",
		Description: "Archive a thread: Claude is closed, its terminals removed, and it is unpinned and listed apart. " +
			"Without archived, toggles. Pinning or sending a message unarchives it too.",
		Category: "Thread",
		Args: []ArgSpec{
			optionalID(idArg),
			threadIDsArg,
			{Name: "archived", Type: Bool, Description: "Archive (true) or unarchive (false); default: the opposite of now (with ids: archive)"},
			descendantsArg("archive the threads below it (not it, unless include-root)"),
			includeRootArg,
		},
		When:    hasThreadOrCLI,
		Confirm: "Archive thread {id}? Claude is still working; archiving ends the turn.",
		ConfirmIf: func(ctx context.Context, c Context, a Args) bool {
			return notSelf(c, a, "archiving") == nil && archiveConfirm(ctx, b, a) != ""
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return archiveConfirm(ctx, b, a)
		},
		Run: func(ctx context.Context, c Context, a Args) (Result, error) {
			if err := notSelf(c, a, "archiving"); err != nil {
				return Result{}, err
			}
			if a.String("descendants-of") != "" {
				if a.Has("ids") {
					return Result{}, InvalidArg("ids", "give ids or descendants-of, not both")
				}
				return archiveSubtree(ctx, b, a)
			}
			if a.Bool("include-root") {
				return Result{}, InvalidArg("include-root", "include-root goes with descendants-of")
			}
			ids, err := targetThreads(a)
			if err != nil {
				return Result{}, err
			}
			if a.Has("ids") {
				return archiveThreads(ctx, b, ids, a), nil
			}
			id := ids[0]
			archived := a.Bool("archived")
			if !a.Has("archived") {
				cur, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				archived = cur.Msg.GetThread().GetArchivedAt() == nil
			}
			res, err := b.Archive(ctx, connect.NewRequest(&v1.ArchiveThreadRequest{Id: id, Archived: archived}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			verb := "unarchived"
			if s.GetArchivedAt() != nil {
				verb = "archived"
			}
			return Result{Message: verb + " thread " + threadLabel(s), JSON: s}, nil
		},
	}
}

// archiveConfirm is thread.archive's confirmation for this call, or "" when it needs
// none: unarchiving, or archiving a thread that is not mid-turn (archiveInterrupts).
// An unknown thread needs none either: Run reports it. Given ids, archiveManyConfirm;
// given descendants-of, archiveSubtreeConfirm.
func archiveConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	if a.String("descendants-of") != "" {
		if a.Has("ids") {
			return "" // Run refuses
		}
		return archiveSubtreeConfirm(ctx, b, a)
	}
	ids, err := targetThreads(a)
	if err != nil {
		return ""
	}
	if a.Has("ids") {
		return archiveManyConfirm(ctx, b, ids, a)
	}
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: ids[0]}))
	if err != nil {
		return ""
	}
	s := res.Msg.GetThread()
	archiving := s.GetArchivedAt() == nil
	if a.Has("archived") {
		archiving = a.Bool("archived")
	}
	if !archiving {
		return ""
	}
	return archiveOneConfirm(ctx, b, s)
}

// archiveOneConfirm is the confirmation for archiving s, or "" when it needs none:
// what archiving cuts off in s (archiveInterrupts) and the hidden threads below it
// still working that it archives too (hiddenWorking), in one question.
func archiveOneConfirm(ctx context.Context, b ThreadBackend, s *v1.Thread) string {
	var parts []string
	if why, ends := archiveInterrupts(s); why != "" {
		parts = append(parts, why+"; archiving "+ends+".")
	}
	if kids := hiddenWorking(ctx, b, []string{s.GetId()}); len(kids) > 0 {
		parts = append(parts, hiddenWorkingText(len(kids), threadNameOrID(s)))
	}
	if len(parts) == 0 {
		return ""
	}
	return "Archive thread " + threadNameOrID(s) + "? " + strings.Join(parts, " ")
}

// archiveInterrupts says what archiving (or snoozing) s would cut off, and what doing
// so ends: "Claude is waiting on your answer" while a permission request or question is
// pending (status reasons "permission: ..." and "question: ...", stream_status.go), or
// "Claude is still working" while it starts or runs a turn, both "ends the turn"; the
// thread's background agents and shells running after its turn ("1 background agent
// and 2 shells are running", "stops them"), or Claude's turn to report one that just
// ended (the wake hold); "" otherwise (idle, a finished or failed turn, closing,
// stopped).
func archiveInterrupts(s *v1.Thread) (why, ends string) {
	if why := midTurn(s); why != "" {
		return why, "ends the turn"
	}
	if s.GetState() != v1.ThreadState_THREAD_STATE_CONNECTED {
		return "", ""
	}
	agents, shells := int(s.GetBackgroundAgentsRunning()), int(s.GetBackgroundShellsRunning())
	if agents+shells == 0 {
		if s.GetBackgroundWakePending() {
			return "Claude is about to report background work that just finished", "loses that report"
		}
		return "", ""
	}
	ends = "stops them"
	if agents+shells == 1 {
		ends = "stops it"
	}
	return backgroundRunning(agents, shells), ends
}

// midTurn says why s is mid-turn: "Claude is still working" while it starts or runs a
// turn, "Claude is waiting on your answer" while a permission request or question is
// pending; "" otherwise. Stopping Claude now cuts that off (archive, snooze, a restart).
func midTurn(s *v1.Thread) string {
	if st := s.GetState(); st == v1.ThreadState_THREAD_STATE_STARTING {
		return "Claude is still working"
	} else if st != v1.ThreadState_THREAD_STATE_CONNECTED {
		return ""
	}
	switch s.GetStatus() {
	case v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION:
		if r := s.GetStatusReason(); strings.HasPrefix(r, "permission:") || strings.HasPrefix(r, "question:") {
			return "Claude is waiting on your answer"
		}
	case v1.ThreadStatus_THREAD_STATUS_BUSY:
		return "Claude is still working"
	}
	return ""
}

// backgroundRunning is "1 background agent is running", "2 background shells are
// running", "1 background agent and 2 shells are running".
func backgroundRunning(agents, shells int) string {
	what := backgroundWork(agents, shells)
	if agents+shells == 1 {
		return what + " is running"
	}
	return what + " are running"
}

// backgroundWork is "1 background agent", "2 background shells", "1 background agent
// and 2 shells"; "" for none.
func backgroundWork(agents, shells int) string {
	switch {
	case agents > 0 && shells > 0:
		return plural(agents, "background agent") + " and " + plural(shells, "shell")
	case agents > 0:
		return plural(agents, "background agent")
	case shells > 0:
		return plural(shells, "background shell")
	}
	return ""
}
