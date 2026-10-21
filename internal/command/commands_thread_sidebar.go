package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Hidden children (docs/notes/hidden-children-1-daemon.md). A thread another thread
// created is its creator's to manage and stays out of the sidebar unless the
// threads.show_created_threads setting or its own override (Thread.in_sidebar) shows
// it. thread.sidebar sets the override (hand a thread to the user, or back), thread.new
// --sidebar sets it at creation, and archiving a thread archives the hidden threads
// below it: thread.archive asks first when any of those is still working.

// SidebarBackend backs thread.sidebar.
type SidebarBackend interface {
	SetSidebar(context.Context, *connect.Request[v1.SetThreadSidebarRequest]) (*connect.Response[v1.SetThreadSidebarResponse], error)
}

// threadSidebarCmd is thread.sidebar: show a thread another thread created in the
// sidebar, or hide it again, whatever the setting says.
func threadSidebarCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.sidebar",
		Title: "Show or Hide Thread in Sidebar",
		Description: "Show a thread another thread created in the sidebar, handing it to the user, or hide it again, handing it back to its creator " +
			"(whatever settings threads.show_created_threads says). A hidden thread is archived with its creator; a shown one is not.",
		Category: "Thread",
		Args: []ArgSpec{
			positional(idArg),
			{Name: "shown", Type: Bool, Required: true, Description: "Show (true) or hide (false) the thread in the sidebar"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.SetSidebar(ctx, connect.NewRequest(&v1.SetThreadSidebarRequest{Id: a.String("id"), Shown: a.Bool("shown")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			where := "hidden from the sidebar"
			if s.GetInSidebar() {
				where = "shown in the sidebar"
			}
			return Result{Message: "thread " + threadLabel(s) + " " + where, JSON: s}, nil
		},
	}
}

// sidebarCreateArg is thread.new's sidebar.
var sidebarCreateArg = ArgSpec{Name: "sidebar", Type: Bool,
	Description: "With created-by: show the new thread in the sidebar (or with false, hide it) whatever settings threads.show_created_threads says; " +
		"a thread another thread creates is hidden by default and archived with its creator"}

// createSidebar sets thread.new's sidebar on req: only with a creator.
func createSidebar(req *v1.CreateThreadRequest, a Args) error {
	if !a.Has("sidebar") {
		return nil
	}
	if strings.TrimSpace(req.GetCreatedBy()) == "" {
		return InvalidArg("sidebar", "only applies to a thread another thread creates (created-by, which defaults to $CODE_FOUNDRY_THREAD inside a thread); a thread you create is always shown")
	}
	v := a.Bool("sidebar")
	req.InSidebar = &v
	return nil
}

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
// working below the thread named root ("": several roots, "its creator" is asked):
// what archiving does to them and how to keep one.
func hiddenWorkingText(n int, root string) string {
	if root == "" {
		root = "its creator"
	}
	if n == 1 {
		return fmt.Sprintf("1 hidden child thread is still working; archiving ends its turn and archives it too. "+
			"To keep it, ask %s to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.", root)
	}
	return fmt.Sprintf("%d hidden child threads are still working; archiving ends their turns and archives them too. "+
		"To keep one, ask %s to hand it over (code-foundry thread sidebar --shown=true) or show it in the sidebar first.", n, root)
}
