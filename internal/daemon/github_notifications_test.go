package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// ghWorld is the glue over the gh fake and the real notification store, evaluated by
// hand (the loop has its own test).
type ghWorld struct {
	t       *testing.T
	gh      *ghtest.Store
	notes   *notificationtest.Store
	threads *thread.Snapshot
	on      bool
	warns   atomic.Int32
	n       *githubNotifier
	opts    githubNotifyOptions
}

// countHandler counts warnings.
type countHandler struct {
	slog.Handler
	warns *atomic.Int32
}

func (h countHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h countHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelWarn {
		h.warns.Add(1)
	}
	return nil
}

func newGhWorld(t *testing.T) *ghWorld {
	w := &ghWorld{t: t, on: true, threads: &thread.Snapshot{}}
	b := bus.New()
	w.gh = ghtest.New(b)
	w.gh.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: ghViewer}, Authenticated: true})
	w.notes = notificationtest.New(t, notificationtest.Options{Bus: b, Threads: []string{"s-1"}})
	log := slog.New(countHandler{Handler: slog.DiscardHandler, warns: &w.warns})
	w.opts = githubNotifyOptions{Log: log, Store: w.notes, GitHub: w.gh.Snapshot, Threads: func() *thread.Snapshot { return w.threads },
		Projects:          func() *project.Snapshot { return &project.Snapshot{} },
		DashboardsEnabled: func() bool { return w.on }, Bus: b}
	w.n = &githubNotifier{log: log, store: w.notes}
	return w
}

func (w *ghWorld) eval(d gh.Dashboard) {
	w.gh.SetDashboard(d)
	w.n.reconcile(context.Background(), planGitHubNotifications(githubNotifyInputOf(w.opts)))
}

// card returns the source's notification with key in any state.
func (w *ghWorld) card(k string) (notification.Notification, bool) {
	for _, n := range w.notes.List(true) {
		if n.Source == githubSource && n.Key == k {
			return n, true
		}
	}
	return notification.Notification{}, false
}

func (w *ghWorld) want(k string, s notification.Status) notification.Notification {
	w.t.Helper()
	n, ok := w.card(k)
	if !ok || n.Status() != s {
		w.t.Fatalf("%s: %v (found %v), want %s", k, n.Status(), ok, s)
	}
	return n
}

// Post, update in place, withdraw: each of the four kinds through the real store.
func TestGitHubNotificationsLifecycle(t *testing.T) {
	w := newGhWorld(t)
	stale := withReviews(review(ghViewer, "APPROVED", "old0000"))
	cr := withReviews(review("dana-k", "CHANGES_REQUESTED", "head1aaaaaaa"))
	conflicting := func(p *gh.PullRequest) { p.Mergeable = gh.MergeableConflicting }
	retitled := func(p *gh.PullRequest) { p.Title = "Tabbed settings" }
	pushed := func(p *gh.PullRequest) { p.HeadSHA = "head2bbbbbbb" }

	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, []gh.PullRequest{ghTestPR(2, stale)}, []gh.PullRequest{ghTestPR(4, cr), ghTestPR(5, conflicting)}, nil))
	ids := map[string]string{}
	for _, k := range []string{key(1, ghReviewRequested), key(2, ghReviewAgain), key(4, ghChangesRequested), key(5, ghConflict)} {
		ids[k] = w.want(k, notification.StatusShown).ID
	}
	if w.notes.Snapshot().TimeSensitive != 2 {
		t.Errorf("time-sensitive = %d, want the two review cards", w.notes.Snapshot().TimeSensitive)
	}

	// Updates: the same card, in place.
	w.eval(dash([]gh.PullRequest{ghTestPR(1, retitled)}, []gh.PullRequest{ghTestPR(2, stale, pushed)},
		[]gh.PullRequest{ghTestPR(4, cr, retitled), ghTestPR(5, conflicting, pushed)}, nil))
	for k, id := range ids {
		if n := w.want(k, notification.StatusShown); n.ID != id {
			t.Errorf("%s: a new card %s, want %s updated", k, n.ID, id)
		}
	}
	if n, _ := w.card(key(1, ghReviewRequested)); n.Body != "Acme/web #1 Tabbed settings · by lee-m, your review is requested" {
		t.Errorf("updated body %q", n.Body)
	}

	// Withdrawals: the viewer reviewed the new head, pushed past the changes requested,
	// resolved the conflict, and the request was removed (the list is whole).
	w.eval(dash(nil, []gh.PullRequest{ghTestPR(2, pushed, withReviews(review(ghViewer, "APPROVED", "head2bbbbbbb")))},
		[]gh.PullRequest{ghTestPR(4, cr, pushed), ghTestPR(5, pushed)}, nil))
	for k := range ids {
		w.want(k, notification.StatusWithdrawn)
	}
	if len(w.notes.Snapshot().Notifications) != 0 {
		t.Errorf("left %+v", w.notes.Snapshot().Notifications)
	}
}

// A dismissed review-again card comes back with the next push; a dismissed
// review-requested card stays gone.
func TestGitHubNotificationsDismissal(t *testing.T) {
	w := newGhWorld(t)
	ctx := context.Background()
	stale := withReviews(review(ghViewer, "APPROVED", "old0000"))
	pushed := func(p *gh.PullRequest) { p.HeadSHA = "head2bbbbbbb" }
	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, []gh.PullRequest{ghTestPR(2, stale)}, nil, nil))
	for _, k := range []string{key(1, ghReviewRequested), key(2, ghReviewAgain)} {
		if _, err := w.notes.Dismiss(ctx, w.want(k, notification.StatusShown).ID); err != nil {
			t.Fatal(err)
		}
	}
	// The same poll again: both stay dismissed.
	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, []gh.PullRequest{ghTestPR(2, stale)}, nil, nil))
	w.want(key(1, ghReviewRequested), notification.StatusDismissed)
	w.want(key(2, ghReviewAgain), notification.StatusDismissed)
	// Both pushed.
	w.eval(dash([]gh.PullRequest{ghTestPR(1, pushed)}, []gh.PullRequest{ghTestPR(2, stale, pushed)}, nil, nil))
	w.want(key(1, ghReviewRequested), notification.StatusDismissed)
	w.want(key(2, ghReviewAgain), notification.StatusShown)
}

// Only positive knowledge withdraws: a failed poll keeps the last good lists, a list cut
// at its page size says nothing about what it misses, a fingerprint alone says nothing
// about the detail, and a signed-out store knows nothing.
func TestGitHubNotificationsNoKnowledgeKeeps(t *testing.T) {
	w := newGhWorld(t)
	cr := withReviews(review("dana-k", "CHANGES_REQUESTED", "head1aaaaaaa"))
	base := dash([]gh.PullRequest{ghTestPR(1)}, nil, []gh.PullRequest{ghTestPR(4, cr), ghTestPR(5, func(p *gh.PullRequest) { p.Mergeable = gh.MergeableConflicting })}, nil)
	w.eval(base)
	keys := []string{key(1, ghReviewRequested), key(4, ghChangesRequested), key(5, ghConflict)}
	check := func(what string) {
		t.Helper()
		for _, k := range keys {
			if n, _ := w.card(k); n.Status() != notification.StatusShown {
				t.Errorf("%s: %s %s", what, k, n.Status())
			}
		}
	}

	failed := base
	failed.LastError = "review_requested: rate limited"
	w.eval(failed)
	check("a failed poll")

	capped := dash(nil, nil, nil, nil)
	capped.ReviewRequestedTotal, capped.AuthoredTotal = 120, 120
	w.eval(capped)
	check("lists cut at their page size")

	w.eval(dash([]gh.PullRequest{ghTestPR(1, partial)}, nil, []gh.PullRequest{ghTestPR(4, partial), ghTestPR(5, partial)}, nil))
	check("fingerprints only")

	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, nil, []gh.PullRequest{ghTestPR(4, cr), ghTestPR(5, func(p *gh.PullRequest) { p.Mergeable = gh.MergeableUnknown })}, nil))
	check("mergeable unknown")

	w.gh.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: ghViewer}, Authenticated: false, LastError: "gh is not authenticated"})
	w.eval(dash(nil, nil, nil, nil))
	check("signed out")
	w.gh.SetViewer(gh.ViewerState{Viewer: &gh.Viewer{Login: ghViewer}, Authenticated: true})

	// Merged: gone, whatever the open lists say.
	merged := func(n int) gh.PullRequest {
		return ghTestPR(n, func(p *gh.PullRequest) { p.State = gh.PullRequestMerged })
	}
	capped.RecentlyMerged = []gh.PullRequest{merged(1), merged(4), merged(5)}
	w.eval(capped)
	for _, k := range keys {
		w.want(k, notification.StatusWithdrawn)
	}
}

// The first evaluation after a start withdraws cards whose pull request is no longer
// known (the lists are whole); turning the source off withdraws every card.
func TestGitHubNotificationsReconcileAndOff(t *testing.T) {
	w := newGhWorld(t)
	ctx := context.Background()
	for _, k := range []string{key(30, ghReviewRequested), key(31, ghConflict), "pr/acme/web#32/checks-failed"} {
		if _, err := w.notes.Post(ctx, notification.Post{Source: githubSource, Key: k, Title: "Old"}); err != nil {
			t.Fatal(err)
		}
	}
	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, nil, nil, nil))
	w.want(key(30, ghReviewRequested), notification.StatusWithdrawn)
	w.want(key(31, ghConflict), notification.StatusWithdrawn)
	w.want("pr/acme/web#32/checks-failed", notification.StatusWithdrawn)
	w.want(key(1, ghReviewRequested), notification.StatusShown)

	w.on = false
	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, nil, nil, nil))
	w.want(key(1, ghReviewRequested), notification.StatusWithdrawn)
	w.on = true
	w.eval(dash([]gh.PullRequest{ghTestPR(1)}, nil, nil, nil))
	w.want(key(1, ghReviewRequested), notification.StatusShown)
}

// A linked thread is named on the card and gets the send; when its link goes (the
// thread archived), the card offers a new thread instead.
func TestGitHubNotificationsLinkedThread(t *testing.T) {
	w := newGhWorld(t)
	at := notificationtest.T0
	w.threads = &thread.Snapshot{Threads: []thread.Thread{{ID: "s-1", LinkedPullRequests: []thread.LinkedPullRequest{{Slug: "Acme/web", Number: 4, LinkedAt: at}}}}}
	cr := withReviews(review("dana-k", "CHANGES_REQUESTED", "head1aaaaaaa"))
	w.eval(dash(nil, nil, []gh.PullRequest{ghTestPR(4, cr)}, nil))
	n := w.want(key(4, ghChangesRequested), notification.StatusShown)
	if n.ThreadID != "s-1" || n.Actions[1].Kind != notification.KindSend || n.Actions[1].ThreadID != "s-1" {
		t.Errorf("linked: %+v", n)
	}
	w.threads = &thread.Snapshot{Threads: []thread.Thread{{ID: "s-1", ArchivedAt: at, LinkedPullRequests: w.threads.Threads[0].LinkedPullRequests}}}
	w.eval(dash(nil, nil, []gh.PullRequest{ghTestPR(4, cr)}, nil))
	if n := w.want(key(4, ghChangesRequested), notification.StatusShown); n.ThreadID != "" || n.Actions[1].Kind != notification.KindStart {
		t.Errorf("archived: %+v", n)
	}
}

// The source's cap: posts past it are refused, logged once until one goes through.
func TestGitHubNotificationsFull(t *testing.T) {
	w := newGhWorld(t)
	var many []gh.PullRequest
	for i := 1; i <= notification.MaxActivePerSource+5; i++ {
		many = append(many, ghTestPR(i))
	}
	d := dash(many, nil, nil, nil)
	w.eval(d)
	w.eval(d)
	if got := len(w.notes.Snapshot().Notifications); got != notification.MaxActivePerSource {
		t.Errorf("active = %d, want the cap", got)
	}
	if got := w.warns.Load(); got != 1 {
		t.Errorf("warnings = %d, want 1", got)
	}
}

func TestPickLinkedThreads(t *testing.T) {
	at := notificationtest.T0
	link := func(slug string, n int, src thread.LinkSource, d time.Duration) thread.LinkedPullRequest {
		return thread.LinkedPullRequest{Slug: slug, Number: n, Source: src, LinkedAt: at.Add(d)}
	}
	s := &thread.Snapshot{Threads: []thread.Thread{
		{ID: "s-parent", LinkedPullRequests: []thread.LinkedPullRequest{link("acme/web", 1, thread.LinkChild, time.Hour), link("acme/web", 2, thread.LinkClaude, 0)}},
		{ID: "s-child", LinkedPullRequests: []thread.LinkedPullRequest{link("Acme/Web", 1, thread.LinkClaude, 0)}},
		{ID: "s-newer", LinkedPullRequests: []thread.LinkedPullRequest{link("acme/web", 2, thread.LinkBranch, time.Minute)}},
		{ID: "s-archived", ArchivedAt: at, LinkedPullRequests: []thread.LinkedPullRequest{link("acme/web", 3, thread.LinkManual, 0)}},
	}}
	got := pickLinkedThreads(s)
	for pr, want := range map[ghPR]string{{"acme/web", 1}: "s-child", {"acme/web", 2}: "s-newer", {"acme/web", 3}: ""} {
		if got[pr] != want {
			t.Errorf("%v: %q, want %q", pr, got[pr], want)
		}
	}
}

func TestProjectsSettled(t *testing.T) {
	for _, tt := range []struct {
		name string
		s    *project.Snapshot
		want bool
	}{
		{"no snapshot", nil, false},
		{"no projects", &project.Snapshot{}, true},
		{"reconciled", &project.Snapshot{Projects: []project.Project{{Git: true, DefaultBranch: "main", GitHubSlug: "acme/web"}}}, true},
		{"a reconcile failed", &project.Snapshot{Projects: []project.Project{{Git: true, Error: "boom"}}}, true},
		{"a plain directory", &project.Snapshot{Projects: []project.Project{{}}}, true},
		{"not reconciled yet", &project.Snapshot{Projects: []project.Project{{Git: true, DefaultBranch: "main"}, {Git: true}}}, false},
	} {
		if got := projectsSettled(tt.s); got != tt.want {
			t.Errorf("%s: %v", tt.name, got)
		}
	}
	if got := trackingProjects(&project.Snapshot{Projects: []project.Project{{ID: "r-1", GitHubSlug: "Acme/Web"}, {ID: "r-2", GitHubSlug: "acme/web"}, {ID: "r-3"}}}); fmt.Sprint(got) != "map[acme/web:r-1]" {
		t.Errorf("tracking %v", got)
	}
}

// The loop: nothing until the projects settle, then an evaluation per burst of events.
func TestGitHubNotificationsLoop(t *testing.T) {
	w := newGhWorld(t)
	unsettled := &project.Snapshot{Projects: []project.Project{{ID: "r-1", Git: true}}}
	var projects atomic.Pointer[project.Snapshot]
	projects.Store(unsettled)
	w.opts.Projects = projects.Load
	w.opts.Settle = time.Hour
	changed := bus.Subscribe[notification.Event](w.opts.Bus, 16)
	defer changed.Close()
	w.gh.SetDashboard(dash([]gh.PullRequest{ghTestPR(1)}, nil, nil, nil))
	stop := startGitHubNotifications(context.Background(), w.opts)
	defer stop()

	// A dashboard event while the projects are not reconciled: nothing posted.
	w.gh.SetDashboard(dash([]gh.PullRequest{ghTestPR(1)}, nil, nil, nil))
	settled := &project.Snapshot{Projects: []project.Project{{ID: "r-1", Git: true, DefaultBranch: "main", GitHubSlug: "acme/web"}}}
	projects.Store(settled)
	if len(w.notes.Snapshot().Notifications) != 0 {
		t.Fatal("posted before the projects settled")
	}
	bus.Publish[project.Event](w.opts.Bus, project.ProjectUpdated{Project: settled.Projects[0]})
	select {
	case <-changed.C():
	case <-time.After(5 * time.Second):
		t.Fatal("no evaluation after the projects settled")
	}
	n := w.want(key(1, ghReviewRequested), notification.StatusShown)
	if n.Actions[1].ProjectID != "r-1" {
		t.Errorf("start action's project %q, want r-1", n.Actions[1].ProjectID)
	}
	// A merge seen by the next poll withdraws it.
	w.gh.SetDashboard(dash(nil, nil, nil, []gh.PullRequest{ghTestPR(1, func(p *gh.PullRequest) { p.State = gh.PullRequestMerged })}))
	select {
	case <-changed.C():
	case <-time.After(5 * time.Second):
		t.Fatal("no evaluation after the dashboard changed")
	}
	w.want(key(1, ghReviewRequested), notification.StatusWithdrawn)
}
