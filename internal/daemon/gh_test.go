package daemon

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
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

func TestStartGhTracksOnlyGitHubProjects(t *testing.T) {
	b := bus.New()
	projects := projecttest.New(b)
	projects.Put(project.Project{ID: "gh", Name: "gh", GitHubSlug: "Acme/App", Remotes: []string{"origin"}})
	projects.Put(project.Project{ID: "local", Name: "momentum"})
	projects.Put(project.Project{ID: "gitlab", Name: "gitlab", Remotes: []string{"origin"}})
	tr := &fakeTracker{tracked: map[string]bool{}}
	stop := startGh(context.Background(), slog.New(slog.DiscardHandler), tr, projects, b)
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

	// The local-only project gains a GitHub origin, then loses it again.
	projects.Put(project.Project{ID: "local", Name: "momentum", GitHubSlug: "me/momentum", Remotes: []string{"origin"}})
	waitTracked("acme/app", "me/momentum")
	projects.Put(project.Project{ID: "local", Name: "momentum"})
	waitTracked("acme/app")
}

// TestStartGhSharedSlug: two registered projects can share a GitHub slug (two clones of
// one repository). The slug stays tracked while any project still has it. Each case ends
// with a marker project on the same topic, so its slug showing up proves the events
// before it were handled.
func TestStartGhSharedSlug(t *testing.T) {
	tests := []struct {
		name string
		run  func(p *projecttest.Fake)
		want []string
	}{
		{"removing one keeps it", func(p *projecttest.Fake) {
			if err := p.Unregister(context.Background(), "a"); err != nil {
				t.Fatal(err)
			}
		}, []string{"acme/app", "marker/m"}},
		{"one's origin changing keeps it", func(p *projecttest.Fake) {
			p.Put(project.Project{ID: "a", Name: "a", GitHubSlug: "acme/fork", Remotes: []string{"origin"}})
		}, []string{"acme/app", "acme/fork", "marker/m"}},
		{"one losing its origin keeps it", func(p *projecttest.Fake) {
			p.Put(project.Project{ID: "b", Name: "b"})
		}, []string{"acme/app", "marker/m"}},
		{"removing both untracks it", func(p *projecttest.Fake) {
			for _, id := range []string{"a", "b"} {
				if err := p.Unregister(context.Background(), id); err != nil {
					t.Fatal(err)
				}
			}
		}, []string{"marker/m"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := bus.New()
			projects := projecttest.New(b)
			projects.Put(project.Project{ID: "a", Name: "a", GitHubSlug: "acme/app", Remotes: []string{"origin"}})
			projects.Put(project.Project{ID: "b", Name: "b", GitHubSlug: "Acme/App", Remotes: []string{"origin"}})
			tr := &fakeTracker{tracked: map[string]bool{}}
			stop := startGh(context.Background(), slog.New(slog.DiscardHandler), tr, projects, b)
			defer stop()
			waitFor := func(slug string) {
				t.Helper()
				deadline := time.Now().Add(5 * time.Second)
				for !slices.Contains(tr.slugs(), slug) {
					if time.Now().After(deadline) {
						t.Fatalf("%s never tracked: %q", slug, tr.slugs())
					}
					time.Sleep(5 * time.Millisecond)
				}
			}
			waitFor("acme/app") // seeded from the snapshot
			tt.run(projects)
			projects.Put(project.Project{ID: "marker", Name: "marker", GitHubSlug: "marker/m", Remotes: []string{"origin"}})
			waitFor("marker/m")
			if got := tr.slugs(); !slices.Equal(got, tt.want) {
				t.Errorf("tracked = %q, want %q", got, tt.want)
			}
		})
	}
}
