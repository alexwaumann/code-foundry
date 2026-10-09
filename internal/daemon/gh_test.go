package daemon

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
)

// fakeTracker records the tracked set.
type fakeTracker struct {
	mu      sync.Mutex
	tracked map[string]bool
}

func (f *fakeTracker) Run(ctx context.Context) error { <-ctx.Done(); return nil }

func (f *fakeTracker) Track(slug string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tracked[slug] = true
	return nil
}

func (f *fakeTracker) Untrack(slug string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.tracked, slug)
	return nil
}

func (f *fakeTracker) slugs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for s := range f.tracked {
		out = append(out, s)
	}
	slices.Sort(out)
	return out
}

func TestStartGhTracksOnlyGitHubRepos(t *testing.T) {
	b := bus.New()
	repos := repotest.New(b)
	repos.Put(repo.Repo{ID: "gh", Name: "gh", GitHubSlug: "Acme/App", Remotes: []string{"origin"}})
	repos.Put(repo.Repo{ID: "local", Name: "momentum"})
	repos.Put(repo.Repo{ID: "gitlab", Name: "gitlab", Remotes: []string{"origin"}})
	tr := &fakeTracker{tracked: map[string]bool{}}
	stop := startGh(context.Background(), slog.New(slog.DiscardHandler), tr, repos, b)
	defer stop()

	waitTracked := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !slices.Equal(tr.slugs(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("tracked = %q, want %q", tr.slugs(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	waitTracked("acme/app")

	// The local-only repo gains a GitHub origin, then loses it again.
	repos.Put(repo.Repo{ID: "local", Name: "momentum", GitHubSlug: "me/momentum", Remotes: []string{"origin"}})
	waitTracked("acme/app", "me/momentum")
	repos.Put(repo.Repo{ID: "local", Name: "momentum"})
	waitTracked("acme/app")
}
