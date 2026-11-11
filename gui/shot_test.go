package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// fakeShotPanel is the window: it records its calls, and its page (onShow) reports
// through the service as the real page would.
type fakeShotPanel struct {
	svc *ShotService
	// onShow plays the page for a request; nil renders it 900 px tall.
	onShow func(req shotPageRequest)
	// picture is what a snapshot gives (default a PNG of the request's id).
	picture func(id string) shotPicture
	// noReady: an opened page never says it is ready.
	noReady bool

	mu       sync.Mutex
	logs     []string
	shown    string
	inFlight int
	overlaps int
}

func (p *fakeShotPanel) log(s string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, s)
}

func (p *fakeShotPanel) got() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.logs)
}

func (p *fakeShotPanel) open() {
	p.log("open")
	if !p.noReady {
		go p.svc.PageReady()
	}
}

func (p *fakeShotPanel) show(width, height int, req shotPageRequest) {
	p.mu.Lock()
	p.logs = append(p.logs, fmt.Sprintf("show:%s %dx%d", req.ID, width, height))
	p.shown = req.ID
	p.inFlight++
	if p.inFlight > 1 {
		p.overlaps++
	}
	p.mu.Unlock()
	if p.onShow != nil {
		p.onShow(req)
		return
	}
	go p.svc.Rendered(req.ID, ShotRendered{ContentHeight: 900})
}

func (p *fakeShotPanel) snapshot() <-chan shotPicture {
	p.mu.Lock()
	id := p.shown
	p.logs = append(p.logs, "snapshot:"+id)
	p.mu.Unlock()
	ch := make(chan shotPicture, 1)
	if p.picture != nil {
		ch <- p.picture(id)
	} else {
		ch <- shotPicture{png: []byte("png:" + id)}
	}
	return ch
}

func (p *fakeShotPanel) hide() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, "hide")
	p.inFlight = 0
}

func (p *fakeShotPanel) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, "close")
	p.inFlight = 0
}

// published collects PublishShot calls as "id png=<bytes> h=<height>" or "id error=<reason>".
type published struct {
	ch chan string
}

func (p *published) publish(_ context.Context, r *v1.PublishShotRequest) error {
	if r.GetError() != "" {
		p.ch <- r.GetId() + " error=" + r.GetError()
	} else {
		p.ch <- fmt.Sprintf("%s png=%s h=%d", r.GetId(), r.GetPng(), r.GetContentHeight())
	}
	return nil
}

// next is the next publish, or "" if none comes within d.
func (p *published) next(t *testing.T, d time.Duration) string {
	t.Helper()
	select {
	case s := <-p.ch:
		return s
	case <-time.After(d):
		return ""
	}
}

func shotReq(id string) *v1.ShotRequest {
	return &v1.ShotRequest{Id: id, Instance: "hello/demo/thread:s-1", MinVersion: 2, Width: 420, Height: 900}
}

// newShotHarness starts a service on a fake panel; stop ends its worker.
func newShotHarness(t *testing.T, panel *fakeShotPanel) (svc *ShotService, pub *published, ctx context.Context, stop func()) {
	t.Helper()
	svc = NewShotService(slog.New(slog.DiscardHandler))
	panel.svc = svc
	svc.panel = panel
	pub = &published{ch: make(chan string, 32)}
	svc.publish = pub.publish
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.run(ctx)
	}()
	stop = func() {
		cancel()
		<-done
	}
	t.Cleanup(stop)
	return svc, pub, ctx, stop
}

const wait = 2 * time.Second

func TestShotOneAtATimeInOrder(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	// The second request arrives while the first is on the page.
	panel.onShow = func(req shotPageRequest) {
		if req.ID == "a" {
			svc.take(ctx, shotReq("b"))
		}
		go svc.Rendered(req.ID, ShotRendered{ContentHeight: 1640})
	}
	svc.take(ctx, shotReq("a"))
	for _, want := range []string{"a png=png:a h=1640", "b png=png:b h=1640"} {
		if got := pub.next(t, wait); got != want {
			t.Fatalf("published %q, want %q", got, want)
		}
	}
	want := []string{"open", "show:a 420x900", "snapshot:a", "hide", "show:b 420x900", "snapshot:b", "hide"}
	if got := panel.got(); !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
	if panel.overlaps != 0 {
		t.Errorf("%d requests shown while another was on the page", panel.overlaps)
	}
}

func TestShotPageFailurePublishesItsReason(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	panel.onShow = func(req shotPageRequest) {
		go svc.Failed(req.ID, "plugin-down", "the plugin hello crashed")
	}
	svc.take(ctx, shotReq("a"))
	if got, want := pub.next(t, wait), "a error=the plugin hello crashed"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	// A reason-less failure says its kind.
	panel.onShow = func(req shotPageRequest) { go svc.Failed(req.ID, "invalid", "") }
	svc.take(ctx, shotReq("b"))
	if got, want := pub.next(t, wait), "b error=invalid"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	want := []string{"open", "show:a 420x900", "hide", "show:b 420x900", "hide"}
	if got := panel.got(); !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

func TestShotSnapshotFailure(t *testing.T) {
	panel := &fakeShotPanel{picture: func(string) shotPicture { return shotPicture{err: errors.New("no image")} }}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	svc.take(ctx, shotReq("a"))
	if got, want := pub.next(t, wait), "a error=the snapshot failed: no image"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
}

// A page that never answers: the host answers before the daemon's 15 s, replaces the
// window, and a request that waited behind it the whole time fails without being drawn.
func TestShotHostTimeout(t *testing.T) {
	panel := &fakeShotPanel{onShow: func(shotPageRequest) {}}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	svc.timeout = 150 * time.Millisecond
	svc.take(ctx, shotReq("a"))
	svc.take(ctx, shotReq("b"))
	if got, want := pub.next(t, wait), "a error=the screenshot page did not answer in time"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	if got, want := pub.next(t, wait), "b error=it waited too long behind other screenshots"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	// A late report for the abandoned request reaches nothing.
	svc.Rendered("a", ShotRendered{ContentHeight: 900})
	// The next request gets a new window, and the page answers this time.
	panel.onShow = nil
	svc.take(ctx, shotReq("c"))
	if got, want := pub.next(t, wait), "c png=png:c h=900"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	want := []string{"open", "show:a 420x900", "close", "open", "show:c 420x900", "snapshot:c", "hide"}
	if got := panel.got(); !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

func TestShotWindowThatNeverLoads(t *testing.T) {
	panel := &fakeShotPanel{noReady: true}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	svc.timeout = 100 * time.Millisecond
	svc.take(ctx, shotReq("a"))
	if got, want := pub.next(t, wait), "a error=the screenshot window did not load in time"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	if got, want := panel.got(), []string{"open", "close"}; !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

// The stream dropping (the daemon has failed its requests): the one on the page is
// dropped unanswered, the window only hidden; the queued one is never drawn; a request
// from the next stream is.
func TestShotStreamDropped(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	stream, drop := context.WithCancel(ctx)
	panel.onShow = func(req shotPageRequest) {
		if req.ID == "a" {
			svc.take(stream, shotReq("b"))
			drop()
			return
		}
		go svc.Rendered(req.ID, ShotRendered{ContentHeight: 900})
	}
	svc.take(stream, shotReq("a"))
	svc.take(ctx, shotReq("c"))
	if got, want := pub.next(t, wait), "c png=png:c h=900"; got != want {
		t.Fatalf("published %q, want %q", got, want)
	}
	if got := pub.next(t, 50*time.Millisecond); got != "" {
		t.Errorf("published %q after the stream's requests", got)
	}
	want := []string{"open", "show:a 420x900", "hide", "show:c 420x900", "snapshot:c", "hide"}
	if got := panel.got(); !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

// The app quitting with a request on the page: the worker returns at once, answers
// nothing and leaves the window (which is going) alone.
func TestShotShutdownMidRequest(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, stop := newShotHarness(t, panel)
	shown := make(chan struct{})
	panel.onShow = func(shotPageRequest) { close(shown) }
	svc.take(ctx, shotReq("a"))
	<-shown
	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(wait):
		t.Fatal("the worker did not stop")
	}
	if got := pub.next(t, 50*time.Millisecond); got != "" {
		t.Errorf("published %q while quitting", got)
	}
	if got, want := panel.got(), []string{"open", "show:a 420x900"}; !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

func TestShotIdleClosesTheWindow(t *testing.T) {
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	svc.idle = 50 * time.Millisecond
	svc.take(ctx, shotReq("a"))
	if got := pub.next(t, wait); !strings.HasPrefix(got, "a png=") {
		t.Fatalf("published %q", got)
	}
	deadline := time.Now().Add(wait)
	for !slices.Contains(panel.got(), "close") {
		if time.Now().After(deadline) {
			t.Fatalf("panel %v: never closed", panel.got())
		}
		time.Sleep(5 * time.Millisecond)
	}
	svc.take(ctx, shotReq("b"))
	if got := pub.next(t, wait); !strings.HasPrefix(got, "b png=") {
		t.Fatalf("published %q", got)
	}
	want := []string{"open", "show:a 420x900", "snapshot:a", "hide", "close", "open", "show:b 420x900", "snapshot:b", "hide"}
	if got := panel.got(); !slices.Equal(got, want) {
		t.Errorf("panel %v, want %v", got, want)
	}
}

func TestShotQueueFull(t *testing.T) {
	svc := NewShotService(slog.New(slog.DiscardHandler))
	pub := &published{ch: make(chan string, 1)}
	svc.publish = pub.publish
	// No worker: the queue fills.
	for i := range shotQueueLen {
		svc.take(context.Background(), shotReq(fmt.Sprint(i)))
	}
	svc.take(context.Background(), shotReq("over"))
	if got, want := pub.next(t, wait), "over error=the app has too many screenshots to take; try again"; got != want {
		t.Errorf("published %q, want %q", got, want)
	}
}

func TestShotPageTimeoutFitsTheHosts(t *testing.T) {
	var got int64
	panel := &fakeShotPanel{}
	svc, pub, ctx, _ := newShotHarness(t, panel)
	panel.onShow = func(req shotPageRequest) {
		got = req.TimeoutMs
		go svc.Rendered(req.ID, ShotRendered{ContentHeight: 900})
	}
	svc.take(ctx, shotReq("a"))
	pub.next(t, wait)
	// 12 s less the capture margin, capped at the page's own 10 s.
	if got != shotPageTimeout.Milliseconds() {
		t.Errorf("page timeout %d ms, want %d", got, shotPageTimeout.Milliseconds())
	}
}

func TestPageRequestOf(t *testing.T) {
	ref := func(c *v1.UiContext, instance string) *v1.SurfaceRef {
		return &v1.SurfaceRef{Plugin: "hello", Surface: "demo", Context: c, Instance: instance}
	}
	tests := []struct {
		name string
		req  *v1.ShotRequest
		want shotPageRequest
	}{
		{
			name: "the request's instance",
			req:  &v1.ShotRequest{Id: "1", Ref: ref(&v1.UiContext{ActiveThreadId: "s-9"}, ""), Instance: "hello/demo/thread:s-1", MinVersion: 3},
			want: shotPageRequest{ID: "1", Plugin: "hello", Surface: "demo", Instance: "hello/demo/thread:s-1", MinVersion: 3, TimeoutMs: 10000},
		},
		{
			name: "the ref's instance",
			req:  &v1.ShotRequest{Id: "1", Ref: &v1.SurfaceRef{Instance: "hello/checks/pr:o/r#1"}},
			want: shotPageRequest{ID: "1", Instance: "hello/checks/pr:o/r#1", TimeoutMs: 10000},
		},
		{
			name: "a thread",
			req:  &v1.ShotRequest{Id: "1", Ref: ref(&v1.UiContext{ActiveThreadId: "s-1", ActiveProjectId: "p-1"}, "")},
			want: shotPageRequest{ID: "1", Plugin: "hello", Surface: "demo", Scope: "thread:s-1", TimeoutMs: 10000},
		},
		{
			name: "a project",
			req:  &v1.ShotRequest{Id: "1", Ref: ref(&v1.UiContext{ActiveProjectId: "p-1", ActiveWorktreePath: "/w"}, "")},
			want: shotPageRequest{ID: "1", Plugin: "hello", Surface: "demo", Scope: "project:p-1", TimeoutMs: 10000},
		},
		{
			name: "a worktree",
			req:  &v1.ShotRequest{Id: "1", Ref: ref(&v1.UiContext{ActiveWorktreePath: "/w"}, "")},
			want: shotPageRequest{ID: "1", Plugin: "hello", Surface: "demo", Scope: "worktree:/w", TimeoutMs: 10000},
		},
		{
			name: "no context: global",
			req:  &v1.ShotRequest{Id: "1", Ref: ref(nil, "")},
			want: shotPageRequest{ID: "1", Plugin: "hello", Surface: "demo", Scope: "global", TimeoutMs: 10000},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pageRequestOf(tt.req, 10*time.Second); got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
