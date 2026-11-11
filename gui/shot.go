package main

import (
	"context"
	"log/slog"
	"sync"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Plugin surface shots (docs/notes/plugin-surface-shot-host.md): the daemon hands the host
// each `plugin surface --shot` request on UiService.WatchShots (shotwatch.go). The host
// draws the surface in a window the user never sees (shot_darwin.go), with the shot page
// (frontend/shot.html), snapshots the webview and answers with UiService.PublishShot. One
// request at a time, in the order they came.

const (
	// shotHostTimeout is how long a request has from the moment the host receives it to
	// its answer: under the daemon's 15 s (shot.DefaultTimeout), so the daemon hears the
	// host's reason rather than its own timeout.
	shotHostTimeout = 12 * time.Second
	// shotPageTimeout is the most the page waits for a live view (its SHOT_TIMEOUT_MS).
	shotPageTimeout = 10 * time.Second
	// shotCaptureMargin is kept, out of what is left of the host's time, for the snapshot
	// after the page reports.
	shotCaptureMargin = 1500 * time.Millisecond
	// shotPublishTimeout bounds one PublishShot call.
	shotPublishTimeout = 5 * time.Second
	// shotIdle is how long the window and its page (and the page's one surface stream)
	// stay after the last shot. An agent iterating on a plugin shoots again within it.
	shotIdle = 2 * time.Minute
	// shotQueueLen is twice the daemon's backlog (shot.queueLen), so a full daemon never
	// fills it.
	shotQueueLen = 16
)

// shotPageRequest is the page's ShotRequest (frontend/src/shot/controller.ts).
type shotPageRequest struct {
	ID         string `json:"id"`
	Plugin     string `json:"plugin"`
	Surface    string `json:"surface"`
	Instance   string `json:"instance,omitempty"`
	Scope      string `json:"scope,omitempty"`
	MinVersion uint64 `json:"minVersion,omitempty"`
	TimeoutMs  int64  `json:"timeoutMs"`
}

// pageRequestOf is the page's request for r, waiting at most timeout for a live view. An
// instance names the surface by itself (the CLI always sends one); without one the scope
// is the context's thread, else its project, else its worktree, else global.
func pageRequestOf(r *v1.ShotRequest, timeout time.Duration) shotPageRequest {
	ref := r.GetRef()
	p := shotPageRequest{
		ID:         r.GetId(),
		Plugin:     ref.GetPlugin(),
		Surface:    ref.GetSurface(),
		Instance:   r.GetInstance(),
		MinVersion: r.GetMinVersion(),
		TimeoutMs:  timeout.Milliseconds(),
	}
	if p.Instance == "" {
		p.Instance = ref.GetInstance()
	}
	if p.Instance != "" {
		return p
	}
	c := ref.GetContext()
	switch {
	case c.GetActiveThreadId() != "":
		p.Scope = "thread:" + c.GetActiveThreadId()
	case c.GetActiveProjectId() != "":
		p.Scope = "project:" + c.GetActiveProjectId()
	case c.GetActiveWorktreePath() != "":
		p.Scope = "worktree:" + c.GetActiveWorktreePath()
	default:
		p.Scope = "global"
	}
	return p
}

// shotPicture is a snapshot: its PNG in device pixels, or why there is none.
type shotPicture struct {
	png []byte
	err error
}

// shotPanel is the hidden window (shotWindow; a fake in tests).
type shotPanel interface {
	// open creates the window, never shown, with the shot page, unless it is there. The
	// page calls ShotService.PageReady once it takes requests.
	open()
	// show sizes the page's viewport to width by height CSS px, orders the window in
	// outside every display and hands the page req; or says why it cannot.
	show(width, height int, req shotPageRequest) error
	// snapshot captures the viewport; the channel gets one picture.
	snapshot() <-chan shotPicture
	// hide orders the window out.
	hide()
	// close destroys the window; the next open makes a new one.
	close()
}

// ShotRendered is the page's report of a surface drawn and measured.
type ShotRendered struct {
	// ContentHeight is the surface's full height in CSS px, its scroll area unrolled.
	ContentHeight int `json:"contentHeight"`
}

// shotAnswer is the page's report: rendered, or the reason it could not.
type shotAnswer struct {
	rendered *ShotRendered
	reason   string
}

// shotJob is a request as received. ctx is its stream's: done when the stream drops (the
// daemon has failed the request already) or the app quits.
type shotJob struct {
	ctx      context.Context
	req      *v1.ShotRequest
	deadline time.Time
}

// ShotService is bound to the shot page, which reports through it (PageReady, Rendered,
// Failed); its worker (run) takes the requests one at a time.
type ShotService struct {
	log *slog.Logger
	// panel and publish are set by main before run starts.
	panel   shotPanel
	publish func(ctx context.Context, r *v1.PublishShotRequest) error
	timeout time.Duration
	idle    time.Duration

	jobs chan shotJob

	mu sync.Mutex
	// open: the panel has a window. ready closes when its page calls PageReady.
	open  bool
	ready chan struct{}
	// current is the id the page draws; answers gets its report.
	current string
	answers chan shotAnswer
}

// NewShotService returns the service; set panel and publish before run.
func NewShotService(log *slog.Logger) *ShotService {
	return &ShotService{
		log:     log,
		timeout: shotHostTimeout,
		idle:    shotIdle,
		jobs:    make(chan shotJob, shotQueueLen),
		ready:   make(chan struct{}),
	}
}

// take queues r, received on a stream whose context is ctx. A full queue answers at once.
func (s *ShotService) take(ctx context.Context, r *v1.ShotRequest) {
	job := shotJob{ctx: ctx, req: r, deadline: time.Now().Add(s.timeout)}
	select {
	case s.jobs <- job:
	default:
		s.log.Warn("shot: queue full", "id", r.GetId())
		s.answerError(job, "the app has too many screenshots to take; try again")
	}
}

// run takes the queued requests one at a time until ctx ends (the app quitting). The
// window goes after shotIdle with no request.
func (s *ShotService) run(ctx context.Context) {
	var idle <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-s.jobs:
			s.shoot(ctx, job)
			if ctx.Err() == nil && s.isOpen() {
				idle = time.After(s.idle)
			}
		case <-idle:
			idle = nil
			s.log.Info("shot: closing the idle window")
			s.closePanel()
		}
	}
}

// shoot draws, captures and answers one request. ctx is the app's.
func (s *ShotService) shoot(ctx context.Context, job shotJob) {
	id := job.req.GetId()
	if job.ctx.Err() != nil {
		return
	}
	jctx, cancel := context.WithDeadline(job.ctx, job.deadline)
	defer cancel()
	if jctx.Err() != nil {
		s.answerError(job, "it waited too long behind other screenshots")
		return
	}
	answer := s.begin(id)
	defer s.end(id)

	// The window, once: its page says when it takes requests.
	ready := s.openPanel()
	select {
	case <-ready:
	case <-jctx.Done():
		s.abandon(ctx, job, "the screenshot window did not load")
		return
	}

	left := time.Until(job.deadline) - shotCaptureMargin
	if err := s.panel.show(int(job.req.GetWidth()), int(job.req.GetHeight()), pageRequestOf(job.req, min(shotPageTimeout, max(left, time.Second)))); err != nil {
		s.panel.hide()
		s.answerError(job, err.Error())
		return
	}
	var got shotAnswer
	select {
	case got = <-answer:
	case <-jctx.Done():
		s.abandon(ctx, job, "the screenshot page did not answer")
		return
	}
	if got.rendered == nil {
		s.panel.hide()
		s.answerError(job, got.reason)
		return
	}

	var pic shotPicture
	select {
	case pic = <-s.panel.snapshot():
	case <-jctx.Done():
		s.abandon(ctx, job, "the snapshot did not finish")
		return
	}
	s.panel.hide()
	if pic.err != nil {
		s.answerError(job, "the snapshot failed: "+pic.err.Error())
		return
	}
	s.log.Info("shot: captured", "id", id, "bytes", len(pic.png), "content_height", got.rendered.ContentHeight)
	s.reply(job, &v1.PublishShotRequest{Id: id, Png: pic.png, ContentHeight: int32(got.rendered.ContentHeight)})
}

// abandon ends a request that ran out of time or lost its stream. Out of time, the
// window is replaced: a page or webview that stopped answering would fail every request
// after it. The app quitting leaves the window alone; it is going.
func (s *ShotService) abandon(ctx context.Context, job shotJob, why string) {
	switch {
	case ctx.Err() != nil:
		return
	case job.ctx.Err() != nil:
		s.panel.hide()
		return
	}
	s.log.Warn("shot: "+why+"; replacing the window", "id", job.req.GetId())
	s.closePanel()
	s.answerError(job, why+" in time")
}

func (s *ShotService) answerError(job shotJob, reason string) {
	if reason == "" {
		reason = "the surface could not be drawn"
	}
	s.reply(job, &v1.PublishShotRequest{Id: job.req.GetId(), Error: reason})
}

// reply publishes r unless the request's stream is gone (the daemon failed it already).
func (s *ShotService) reply(job shotJob, r *v1.PublishShotRequest) {
	if job.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(job.ctx, shotPublishTimeout)
	defer cancel()
	if err := s.publish(ctx, r); err != nil {
		s.log.Warn("shot: publish", "id", r.GetId(), "err", err)
	}
}

// begin makes id the request the page's reports are for.
func (s *ShotService) begin(id string) <-chan shotAnswer {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = id
	s.answers = make(chan shotAnswer, 1)
	return s.answers
}

func (s *ShotService) end(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current == id {
		s.current, s.answers = "", nil
	}
}

func (s *ShotService) openPanel() <-chan struct{} {
	s.mu.Lock()
	open := s.open
	s.open = true
	ready := s.ready
	s.mu.Unlock()
	if !open {
		s.panel.open()
	}
	return ready
}

func (s *ShotService) closePanel() {
	s.mu.Lock()
	open := s.open
	s.open = false
	s.ready = make(chan struct{})
	s.mu.Unlock()
	if open {
		s.panel.close()
	}
}

func (s *ShotService) isOpen() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.open
}

// deliver hands the page's report for id to the request waiting on it, if it still is.
func (s *ShotService) deliver(id string, a shotAnswer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id == "" || id != s.current || s.answers == nil {
		return
	}
	select {
	case s.answers <- a:
	default:
	}
}

// PageReady is the shot page, loaded, saying it takes requests (window.cfShot is set).
func (s *ShotService) PageReady() {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.ready:
	default:
		close(s.ready)
	}
}

// Rendered is the page's report that request id's surface is drawn: the host snapshots it.
func (s *ShotService) Rendered(id string, r ShotRendered) {
	s.deliver(id, shotAnswer{rendered: &r})
}

// Failed is the page's report that request id could not be drawn: failure is its kind
// ("plugin-down", "failed", "unavailable", "timeout", "invalid"), reason its words.
func (s *ShotService) Failed(id, failure, reason string) {
	if reason == "" {
		reason = failure
	}
	s.deliver(id, shotAnswer{reason: reason})
}
