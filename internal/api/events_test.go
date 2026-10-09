package api

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/gitops"
	"github.com/alexwaumann/code-foundry/internal/store/gitops/gitopstest"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/repo/repotest"
	"github.com/alexwaumann/code-foundry/internal/store/session"
	"github.com/alexwaumann/code-foundry/internal/store/session/sessiontest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

type eventsFixture struct {
	bus    *bus.Bus
	repo   *repotest.Fake
	term   *terminaltest.Fake
	sess   *sessiontest.Fake
	gh     *ghtest.Store
	gitops *gitopstest.Fake
	set    *settingstest.Fake
	update *update.Store
	done   chan struct{}
	client codefoundryv1connect.EventServiceClient
}

func newEventsFixture(t *testing.T) *eventsFixture {
	t.Helper()
	b := bus.New()
	set, err := settingstest.New(context.Background(), t.TempDir(), b, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = set.Close() })
	// A disabled updater: its snapshot is the status and it never checks.
	upd := update.Start(context.Background(), update.Options{Current: "dev", DisabledReason: "dev build", Bus: b, InitialDelay: time.Hour})
	t.Cleanup(upd.Close)
	f := &eventsFixture{bus: b, repo: repotest.New(b), term: terminaltest.New(b), sess: sessiontest.New(b), gh: ghtest.New(b), gitops: gitopstest.New(b), set: set, update: upd, done: make(chan struct{})}
	route := NewEvents(EventsDeps{Bus: b, Repo: f.repo, Terminal: f.term, Session: f.sess, Gh: f.gh, GitOps: f.gitops, Settings: f.set, Update: f.update, Done: f.done}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	// HTTP/2 like the repo drop test: flow-control windows bound how much the handler
	// can write ahead of a client that is not reading.
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	f.client = codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
	return f
}

type eventStream struct {
	t *testing.T
	s *connect.ServerStreamForClient[v1.Event]
}

func (f *eventsFixture) watch(t *testing.T, ctx context.Context, sources ...v1.EventSource) *eventStream {
	t.Helper()
	s, err := f.client.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: sources}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return &eventStream{t: t, s: s}
}

func (e *eventStream) next() *v1.Event {
	e.t.Helper()
	if !e.s.Receive() {
		e.t.Fatalf("stream ended: %v", e.s.Err())
	}
	return e.s.Msg()
}

// describe renders an event compactly for order assertions.
func describe(ev *v1.Event) string {
	switch e := ev.GetEvent().(type) {
	case *v1.Event_Repo:
		switch r := e.Repo.GetEvent().(type) {
		case *v1.RepoEvent_Snapshot:
			return fmt.Sprintf("repo.snapshot(%d)", len(r.Snapshot.GetRepos()))
		case *v1.RepoEvent_RepoUpdated:
			return "repo.updated " + r.RepoUpdated.GetName()
		case *v1.RepoEvent_RepoRemovedId:
			return "repo.removed"
		case *v1.RepoEvent_WorktreeDetailUpdated:
			return "repo.detail " + r.WorktreeDetailUpdated.GetPath()
		default:
			return "repo.other"
		}
	case *v1.Event_Terminal:
		if u := e.Terminal.GetUpdated(); u != nil {
			return "terminal.updated " + u.GetId()
		}
		return "terminal.removed " + e.Terminal.GetRemovedId()
	case *v1.Event_Session:
		switch x := e.Session.GetEvent().(type) {
		case *v1.SessionEvent_Snapshot:
			return fmt.Sprintf("session.snapshot(%d)", len(x.Snapshot.GetSessions()))
		case *v1.SessionEvent_Updated:
			return "session.updated " + x.Updated.GetId() + " " + x.Updated.GetStatus().String()
		case *v1.SessionEvent_RemovedId:
			return "session.removed " + x.RemovedId
		default:
			return "session.other"
		}
	case *v1.Event_Gh:
		if p := e.Gh.GetPolled(); p != nil {
			return "gh.polled " + p.GetLastError()
		}
		if e.Gh.GetDashboardUpdated() != nil {
			return "gh.dashboard"
		}
		if p := e.Gh.GetRepoActivityUpdated(); p != nil {
			return "gh.activity " + p.GetRepoSlug()
		}
		if p := e.Gh.GetBranchPullRequestsUpdated(); p != nil {
			return "gh.branch " + p.GetRepoSlug() + " " + p.GetHeadRef()
		}
		return "gh.viewer"
	case *v1.Event_Gitops:
		switch g := e.Gitops.GetEvent().(type) {
		case *v1.GitOpsEvent_Snapshot:
			return fmt.Sprintf("gitops.snapshot(%d)", len(g.Snapshot.GetOps()))
		case *v1.GitOpsEvent_Queued:
			return "gitops.queued " + g.Queued.GetKind().String()
		case *v1.GitOpsEvent_Started:
			return "gitops.started " + g.Started.GetKind().String()
		case *v1.GitOpsEvent_Finished:
			return "gitops.finished " + g.Finished.GetKind().String() + " " + g.Finished.GetState().String()
		default:
			return "gitops.other"
		}
	case *v1.Event_Settings:
		if sn := e.Settings.GetSnapshot(); sn != nil {
			return fmt.Sprintf("settings.snapshot(%d)", sn.GetRevision())
		}
		return "settings.other"
	case *v1.Event_Update:
		if st := e.Update.GetStatus(); st != nil {
			return "update.status " + st.GetState().String()
		}
		return "update.other"
	case *v1.Event_Ui:
		if p := e.Ui.GetOpenPalette(); p != nil {
			return "ui.palette " + p.GetQuery()
		}
		return "ui.other"
	}
	return "?"
}

func TestEventsSnapshotOrderThenLive(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = f.repo.Register(ctx, "/code/a")
	t1, _ := f.term.Create(ctx, terminal.Spec{Argv: []string{"zsh"}})
	t2, _ := f.term.Create(ctx, terminal.Spec{Argv: []string{"claude"}, Labels: map[string]string{"session": "s1"}})
	f.sess.Put(session.Session{ID: "s1", TerminalID: t2.ID, State: session.StateConnected, Status: session.StatusIdle})
	f.gh.SetRepo(gh.RepoState{Slug: "o/b"})
	f.gh.SetRepo(gh.RepoState{Slug: "o/a"})
	f.gitops.Put(gitops.Op{ID: "op-0", Kind: gitops.KindFetch, State: gitops.StateRunning})

	s := f.watch(t, ctx)
	want := []string{
		"repo.snapshot(1)",
		"terminal.updated " + t1.ID,
		"terminal.updated " + t2.ID,
		"session.snapshot(1)",
		"gh.viewer",
		"gh.polled ",
		"gh.dashboard",
		"gh.activity o/a",
		"gh.activity o/b",
		"gitops.snapshot(1)",
		"settings.snapshot(1)",
		"update.status UPDATE_STATE_IDLE",
	}
	for i, w := range want {
		if got := describe(s.next()); got != w {
			t.Fatalf("snapshot event %d = %q, want %q", i, got, w)
		}
	}

	// Live events from every source, each in its own source's order.
	_, _ = f.repo.Register(ctx, "/code/b")
	if got := describe(s.next()); got != "repo.updated b" {
		t.Fatalf("got %q, want repo.updated b", got)
	}
	_ = f.term.Exit(t1.ID, 0)
	if got := describe(s.next()); got != "terminal.updated "+t1.ID {
		t.Fatalf("got %q, want terminal update", got)
	}
	_ = f.term.Remove(ctx, t1.ID)
	if got := describe(s.next()); got != "terminal.removed "+t1.ID {
		t.Fatalf("got %q, want terminal removal", got)
	}
	f.sess.Put(session.Session{ID: "s1", TerminalID: t2.ID, State: session.StateConnected, Status: session.StatusNeedsAttention})
	if got := describe(s.next()); got != "session.updated s1 SESSION_STATUS_NEEDS_ATTENTION" {
		t.Fatalf("got %q, want session update", got)
	}
	f.gh.SetViewer(gh.ViewerState{Authenticated: true})
	if got := describe(s.next()); got != "gh.viewer" {
		t.Fatalf("got %q, want gh.viewer", got)
	}
	f.gh.SetPoll(gh.PollState{FetchedAt: time.Now(), LastError: "boom"})
	if got := describe(s.next()); got != "gh.polled boom" {
		t.Fatalf("got %q, want gh.polled boom", got)
	}
	_, _ = f.gitops.Push(ctx, gitops.PushOptions{WorktreePath: "/code/a"})
	for _, w := range []string{"gitops.started GIT_OP_KIND_PUSH", "gitops.finished GIT_OP_KIND_PUSH GIT_OP_STATE_SUCCEEDED"} {
		if got := describe(s.next()); got != w {
			t.Fatalf("got %q, want %q", got, w)
		}
	}
	// Phase 3a events.
	f.gh.SetDashboard(gh.Dashboard{})
	f.gh.SetActivity("o/a", gh.RepoActivity{})
	f.gh.SetBranchPullRequests(gh.BranchPullRequests{Slug: "o/a", HeadRef: "feat"})
	// Separate bus topics: order across them is not kept.
	got := []string{describe(s.next()), describe(s.next()), describe(s.next())}
	slices.Sort(got)
	if want := []string{"gh.activity o/a", "gh.branch o/a feat", "gh.dashboard"}; !slices.Equal(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	f.repo.SetDetail(repo.WorktreeDetail{RepoID: "r", Path: "/code/a"})
	if got := describe(s.next()); got != "repo.detail /code/a" {
		t.Fatalf("got %q, want repo.detail", got)
	}
	n := command.BusEmitter{Bus: f.bus}.Emit(&v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: "x"}}})
	if n != 1 {
		t.Errorf("Emit delivered to %d, want 1 (the events stream)", n)
	}
	if got := describe(s.next()); got != "ui.palette x" {
		t.Fatalf("got %q, want ui.palette x", got)
	}
	// The labels that place session terminals survive the mapping.
	if l := f.term.List(ctx); len(l) != 1 || l[0].Labels["session"] != "s1" {
		t.Fatalf("list = %v", l)
	}
}

func TestEventsSourceFilter(t *testing.T) {
	tests := []struct {
		name    string
		sources []v1.EventSource
		want    string // first event after the trigger sequence below
	}{
		{"ui only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_UI}, "ui.palette go"},
		{"terminal only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_TERMINAL}, "terminal.updated fake-1"},
		{"repo and ui", []v1.EventSource{v1.EventSource_EVENT_SOURCE_UI, v1.EventSource_EVENT_SOURCE_REPO}, "repo.snapshot(0)"},
		{"session only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_SESSION}, "session.snapshot(0)"},
		{"gh only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_GH}, "gh.viewer"},
		{"gitops only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_GITOPS}, "gitops.snapshot(0)"},
		{"settings only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_SETTINGS}, "settings.snapshot(1)"},
		{"update only", []v1.EventSource{v1.EventSource_EVENT_SOURCE_UPDATE}, "update.status UPDATE_STATE_IDLE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newEventsFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			// Watch returns once headers arrive, so a source with no snapshot still
			// has its subscription in place.
			s := f.watch(t, ctx, tt.sources...)
			f.gh.SetViewer(gh.ViewerState{})
			_, _ = f.term.Create(ctx, terminal.Spec{Argv: []string{"zsh"}})
			command.BusEmitter{Bus: f.bus}.Emit(&v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: "go"}}})
			if got := describe(s.next()); got != tt.want {
				t.Fatalf("first event = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestEventsResyncsSourceAfterDrops(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_REPO, v1.EventSource_EVENT_SOURCE_UI)
	if got := describe(s.next()); got != "repo.snapshot(0)" {
		t.Fatalf("first = %q", got)
	}
	// Overflow the repo subscription while the client is not reading (more than the
	// HTTP/2 flow-control windows the handler can fill first).
	big := strings.Repeat("x", 4096)
	for i := range 2000 {
		f.repo.Put(repo.Repo{ID: fmt.Sprint(i % 3), Name: fmt.Sprint(i), Path: big})
	}
	for {
		ev := s.next()
		if snap := ev.GetRepo().GetSnapshot(); snap != nil && len(snap.GetRepos()) == 3 {
			break
		}
	}
	// The stream is still live for the other sources.
	command.BusEmitter{Bus: f.bus}.Emit(&v1.UiIntent{Intent: &v1.UiIntent_OpenPalette_{OpenPalette: &v1.UiIntent_OpenPalette{Query: "after"}}})
	for {
		if describe(s.next()) == "ui.palette after" {
			return
		}
	}
}

func TestEventsDoneEndsStream(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_UI)
	close(f.done)
	for s.s.Receive() {
	}
	if err := s.s.Err(); err != nil {
		t.Errorf("stream ended with %v, want clean end", err)
	}
}

// A terminal resync must also retract terminals the client knows but that were removed
// while its events were being dropped; terminal.proto has no snapshot message.
func TestTerminalSourceSnapshotRetractsRemoved(t *testing.T) {
	ctx := context.Background()
	fake := terminaltest.New(nil)
	a, _ := fake.Create(ctx, terminal.Spec{Argv: []string{"a"}})
	b, _ := fake.Create(ctx, terminal.Spec{Argv: []string{"b"}})
	src := &terminalSource{store: fake, bus: fake.Bus(), known: map[string]bool{}}

	tests := []struct {
		name   string
		mutate func()
		want   []string
	}{
		{"initial", func() {}, []string{"terminal.updated " + a.ID, "terminal.updated " + b.ID}},
		{"a removed, c added", func() {
			_ = fake.Exit(a.ID, 0)
			_ = fake.Remove(ctx, a.ID)
			_, _ = fake.Create(ctx, terminal.Spec{Argv: []string{"c"}})
		}, []string{"terminal.updated " + b.ID, "terminal.updated fake-3", "terminal.removed " + a.ID}},
		{"nothing changed", func() {}, []string{"terminal.updated " + b.ID, "terminal.updated fake-3"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.mutate()
			var got []string
			for _, ev := range src.snapshot(ctx) {
				got = append(got, describe(ev))
			}
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Fatalf("snapshot = %v, want %v", got, tt.want)
			}
		})
	}
	// A live removal also forgets the id, so the next snapshot does not retract it again.
	src.wrap(terminal.Event{RemovedID: b.ID})
	if src.known[b.ID] {
		t.Fatal("removed id still known")
	}
}
