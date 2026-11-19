package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// focusGainer is the thread store as the focus glue needs it (thread.Manager.FocusGained).
type focusGainer interface {
	FocusGained(id string)
}

// startThreadFocus tells the thread store when a thread gains the focus in the window
// (docs/notes/thread-mark-unread.md): after each layout commit, when the thread the user
// looks at (core.FocusedThread: the active tab of the current space's focused pane, a
// thread's own tab) is not the one it was after the commit before. Its tab activated,
// its pane focused after another, its space switched to, its row selected: each is a
// layout commit. A commit that leaves the focus where it was tells nothing, so a thread
// marked unread while focused stays marked until the focus leaves and comes back. The
// layout store never imports the thread store; this is the glue. The returned func stops
// it.
func startThreadFocus(ctx context.Context, threads focusGainer, l layoutstore.Store, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[layoutstore.Event](b, 256)
	prev := core.FocusedThread(l.Snapshot().State) // subscribed first: nothing between is missed
	var drops uint64
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-events.C():
				st := ev.State
				if n := events.Dropped(); st == nil || n != drops {
					drops = n
					st = l.Snapshot().State // the newest: a dropped commit is behind it
				}
				now := core.FocusedThread(st)
				if now != prev && now != "" {
					threads.FocusGained(now)
				}
				prev = now
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
