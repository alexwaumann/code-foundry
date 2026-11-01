package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Hidden children (docs/notes/no-sidebar-override-2-daemon.md). A thread another thread
// created is its creator's and stays out of the sidebar while its creator exists;
// nothing shows it (the user forks it to take its work over). Archiving or removing a
// thread takes every thread below it along: thread.archive asks first when any of those
// is still working, thread.remove names them (commands_thread_bulk.go).

// forkToKeep is how the user keeps a hidden child's work before its creator takes it
// along: fork it, the fork is the user's.
const forkToKeep = "fork it first (code-foundry thread fork --id <id>)."

// hiddenWorking are the threads archiving each of ids takes with it
// (ThreadFilter.archive_cascade_of) that are mid-turn (midTurn: starting, working, or
// waiting on an answer), without ids themselves, each once. An id the daemon does not
// know has none (Run reports it).
func hiddenWorking(ctx context.Context, b ThreadBackend, ids []string) []*v1.Thread {
	skip := make(map[string]bool, len(ids))
	for _, id := range ids {
		skip[id] = true
	}
	var out []*v1.Thread
	for _, id := range ids {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{ArchiveCascadeOf: id}}))
		if err != nil {
			continue
		}
		for _, s := range res.Msg.GetThreads() {
			if skip[s.GetId()] || midTurn(s) == "" {
				continue
			}
			skip[s.GetId()] = true
			out = append(out, s)
		}
	}
	return out
}

// hiddenWorkingText is the clause thread.archive adds for n hidden threads still
// working below the archived ones: what archiving does to them and how to keep the work
// of one.
func hiddenWorkingText(n int) string {
	if n == 1 {
		return "1 hidden child thread is still working; archiving ends its turn and archives it too. To keep its work, " + forkToKeep
	}
	return fmt.Sprintf("%d hidden child threads are still working; archiving ends their turns and archives them too. "+
		"To keep the work of one, "+forkToKeep, n)
}
