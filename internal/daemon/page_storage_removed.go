package daemon

import (
	"context"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// pageThreads is the page store as it hears of removed threads (page.Store.ThreadRemoved).
type pageThreads interface{ ThreadRemoved(id string) }

// startPageThreadCleanup removes the storage of a removed thread's pages-directory pages
// with the thread (docs/notes/page-storage-per-file.md): the thread store deletes the
// directory, and the page store keeps each page's storage by its file. The storage of a
// page anywhere else stays with the file.
func startPageThreadCleanup(ctx context.Context, b *bus.Bus, pages pageThreads) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	threads := bus.Subscribe[thread.Event](b, 256)
	var wg sync.WaitGroup
	wg.Go(func() {
		defer threads.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-threads.C():
				if e, ok := ev.(thread.Removed); ok {
					pages.ThreadRemoved(e.ID)
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
