package daemon

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// GitHub notifications (docs/notes/notifications-github.md): the daemon posts to the bell
// from what the GitHub store already polls, and withdraws each card as soon as its
// condition is known to be gone. The rules are a pure function
// (github_notifications_rules.go); this glue gathers its input from the stores and
// reconciles the notification store with its outcome after every change.

const (
	// githubNotifyDebounce gathers a burst of events (a poll, a thread's turn) into one
	// evaluation.
	githubNotifyDebounce = 300 * time.Millisecond
	// githubProjectsSettle bounds the wait for the projects' first reconcile after a
	// start (projectsSettled).
	githubProjectsSettle = time.Minute
)

// githubNotificationStore is the part of the notification store the glue drives.
// *notification.Manager implements it.
type githubNotificationStore interface {
	Snapshot() *notification.Snapshot
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
	Withdraw(ctx context.Context, source, key string) (notification.Notification, error)
}

var _ githubNotificationStore = (*notification.Manager)(nil)

// githubNotifyOptions are startGitHubNotifications' inputs.
type githubNotifyOptions struct {
	Log      *slog.Logger
	Store    githubNotificationStore
	GitHub   func() *gh.Snapshot
	Threads  func() *thread.Snapshot
	Projects func() *project.Snapshot
	// DashboardsEnabled is the github.dashboards_enabled setting.
	DashboardsEnabled func() bool
	Bus               *bus.Bus
	// Settle is githubProjectsSettle; tests shorten it.
	Settle time.Duration
}

// githubNotifier reconciles the source's notifications with the plan.
type githubNotifier struct {
	log   *slog.Logger
	store githubNotificationStore
	full  bool // the last evaluation had posts refused ErrFull (logged once until one has none)
}

// projectsSettled reports whether every project has been reconciled since the start: a
// project registered this run has no GitHub slug until then, and one hydrated from the
// last run's cache (Cached) may have a slug that changed while the daemon was down. A
// start action's project (part of a card's content) would flip with it and bring a
// dismissed card back. A project whose reconcile failed counts as settled (the
// evaluation does not wait on a retry that may never succeed).
func projectsSettled(s *project.Snapshot) bool {
	if s == nil {
		return false
	}
	for _, p := range s.Projects {
		if (p.Cached || (p.Git && p.DefaultBranch == "")) && p.Error == "" {
			return false
		}
	}
	return true
}

// pickLinkedThreads names, per pull request, the thread a card about it is sent to: a
// thread that is not archived and links it, its own link (Claude's, a branch's, by hand)
// before one copied from a thread it created (that thread owns the work), then the
// newest link, then the id.
func pickLinkedThreads(s *thread.Snapshot) map[ghPR]string {
	type pick struct {
		id    string
		child bool
		at    time.Time
	}
	best := map[ghPR]pick{}
	if s == nil {
		return nil
	}
	for _, th := range s.Threads {
		if !th.ArchivedAt.IsZero() {
			continue
		}
		for _, l := range th.LinkedPullRequests {
			k := ghPR{strings.ToLower(l.Slug), l.Number}
			c := pick{th.ID, l.Source == thread.LinkChild, l.LinkedAt}
			b, ok := best[k]
			if !ok || cmp.Or(compareBool(b.child, c.child), c.at.Compare(b.at), strings.Compare(b.id, c.id)) > 0 {
				best[k] = c
			}
		}
	}
	out := make(map[ghPR]string, len(best))
	for k, p := range best {
		out[k] = p.id
	}
	return out
}

// compareBool orders true after false.
func compareBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return 1
	}
	return -1
}

// trackingProjects names the project tracking each repository: the first registered
// project whose origin is it.
func trackingProjects(s *project.Snapshot) map[string]string {
	out := map[string]string{}
	if s == nil {
		return out
	}
	for _, p := range s.Projects {
		if slug := strings.ToLower(p.GitHubSlug); slug != "" {
			if _, ok := out[slug]; !ok {
				out[slug] = p.ID
			}
		}
	}
	return out
}

// githubNotifyInputOf gathers the rules' input. A signed-out store has no viewer here:
// its lists are the last known, but nothing about them is current.
func githubNotifyInputOf(o githubNotifyOptions) ghNotifyInput {
	g := o.GitHub()
	in := ghNotifyInput{Off: o.DashboardsEnabled != nil && !o.DashboardsEnabled(), Dashboard: g.Dashboard,
		Threads: pickLinkedThreads(o.Threads()), Projects: trackingProjects(o.Projects())}
	if v := g.Viewer; v.Authenticated && v.Viewer != nil {
		in.Viewer = v.Viewer.Login
	}
	return in
}

// reconcile posts the plan's cards and withdraws the source's other active cards whose
// condition is known to be gone.
func (n *githubNotifier) reconcile(ctx context.Context, plan ghPlan) {
	refused := 0
	for _, p := range plan.Posts {
		_, err := n.store.Post(ctx, p)
		switch {
		case errors.Is(err, notification.ErrFull):
			refused++
		case errors.Is(err, notification.ErrNotFound):
			// The named thread went between the snapshot and the post: the next
			// evaluation names another or none.
			n.log.Debug("github notification not posted", "key", p.Key, "err", err)
		case err != nil:
			n.log.Warn("github notification not posted", "key", p.Key, "err", err)
		}
	}
	if refused > 0 && !n.full {
		n.log.Warn("github notifications: the source is full; the rest wait for room", "refused", refused, "max", notification.MaxActivePerSource)
	}
	n.full = refused > 0
	snap := n.store.Snapshot()
	if snap == nil {
		return
	}
	for _, a := range snap.Notifications {
		if a.Source != githubSource || !plan.Withdraw(a.Key) {
			continue
		}
		if _, err := n.store.Withdraw(ctx, githubSource, a.Key); err != nil && !errors.Is(err, notification.ErrNotFound) {
			n.log.Warn("github notification not withdrawn", "key", a.Key, "err", err)
		}
	}
}

// startGitHubNotifications evaluates once the projects have settled after the start (the
// first evaluation reconciles what changed while the daemon was stopped), then after
// every change of the dashboards, the viewer, the threads, the projects or the settings.
// The returned func stops it.
func startGitHubNotifications(ctx context.Context, o githubNotifyOptions) func() {
	ctx, cancel := context.WithCancel(ctx)
	if o.Settle == 0 {
		o.Settle = githubProjectsSettle
	}
	dash := bus.Subscribe[gh.DashboardUpdated](o.Bus, 16)
	viewer := bus.Subscribe[gh.ViewerUpdated](o.Bus, 16)
	threads := bus.Subscribe[thread.Event](o.Bus, 256)
	projects := bus.Subscribe[project.Event](o.Bus, 256)
	sets := bus.Subscribe[settings.Changed](o.Bus, 16)
	n := &githubNotifier{log: o.Log, store: o.Store}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer dash.Close()
		defer viewer.Close()
		defer threads.Close()
		defer projects.Close()
		defer sets.Close()
		settled := projectsSettled(o.Projects())
		settleBy := time.NewTimer(o.Settle)
		defer settleBy.Stop()
		debounce := time.NewTimer(0) // the first evaluation
		defer debounce.Stop()
		pending := true
		poke := func() {
			if !pending {
				pending = true
				debounce.Reset(githubNotifyDebounce)
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-dash.C():
				if !ok {
					return
				}
				poke()
			case _, ok := <-viewer.C():
				if !ok {
					return
				}
				poke()
			case _, ok := <-threads.C():
				if !ok {
					return
				}
				poke()
			case _, ok := <-projects.C():
				if !ok {
					return
				}
				if !settled && projectsSettled(o.Projects()) {
					settled = true
				}
				poke()
			case _, ok := <-sets.C():
				if !ok {
					return
				}
				poke()
			case <-settleBy.C:
				if !settled {
					settled = true
					o.Log.Info("github notifications: projects not reconciled yet; evaluating anyway")
					poke()
				}
			case <-debounce.C:
				pending = false
				if settled {
					n.reconcile(ctx, planGitHubNotifications(githubNotifyInputOf(o)))
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
