package daemon

import (
	"context"
	"log/slog"
	"strings"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// startGh runs the GitHub poller and keeps its tracked set equal to the GitHub slugs of
// the registered repositories. The tracked set is not persisted, so this runs on every
// daemon start: subscribe first, then seed from the snapshot, so no event is missed.
// The returned func stops both and waits for them.
func startGh(ctx context.Context, log *slog.Logger, store *gh.Store, repos *repo.Git, b *bus.Bus) func() {
	runCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := store.Run(runCtx); err != nil && runCtx.Err() == nil {
			log.Error("gh poller stopped", "err", err)
		}
	}()

	sub := bus.Subscribe[repo.Event](b, 0)
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer sub.Close()
		slugs := map[string]string{} // repo id -> tracked slug
		track := func(id, slug string) {
			slug = strings.ToLower(slug)
			if prev, ok := slugs[id]; ok && prev == slug {
				return
			}
			if prev, ok := slugs[id]; ok && prev != "" {
				if err := store.Untrack(prev); err != nil {
					log.Warn("gh untrack", "slug", prev, "err", err)
				}
			}
			delete(slugs, id)
			if slug == "" {
				return
			}
			if err := store.Track(slug); err != nil {
				log.Warn("gh track", "slug", slug, "err", err)
				return
			}
			slugs[id] = slug
		}
		for _, r := range repos.Snapshot().Repos {
			track(r.ID, r.GitHubSlug)
		}
		for {
			select {
			case <-runCtx.Done():
				return
			case ev := <-sub.C():
				switch e := ev.(type) {
				case repo.RepoUpdated:
					track(e.Repo.ID, e.Repo.GitHubSlug)
				case repo.RepoRemoved:
					track(e.ID, "")
				}
			}
		}
	}()

	return func() {
		cancel()
		wg.Wait()
	}
}
