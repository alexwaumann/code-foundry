package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/shot"
	"github.com/alexwaumann/code-foundry/internal/store/page"
)

// Page checks (page.check; docs/notes/page-self-check.md): the daemon has no browser, so
// the app's host renders the page in its hidden shot window, as a card of the thread it acts
// for would, and answers what the render saw. The broker is the plugin shots' one.

const (
	// PageCheckWidth is a check's card width when none is asked for: a thread pane's
	// conversation column on a laptop screen.
	PageCheckWidth = 720
	// PageCheckHeight is the shot window's height for a check: the tallest card frame a
	// check draws (a taller page asks in vain and is cut there).
	PageCheckHeight = 2400
	// PageCheckSettle is how long a check waits for the page to settle when not told, and
	// PageCheckSettleMax the most it may be told.
	PageCheckSettle    = 5 * time.Second
	PageCheckSettleMax = 10 * time.Second
)

// ErrNoWindow is a check with no app to render the page: it says so rather than "no errors".
var ErrNoWindow = errors.New("no Code Foundry window is open to render the page, so nothing was checked (open the app: code-foundry gui)")

// WithChecks serves CheckPage from b, whose capturer is the app's host (UiService.WatchShots).
func (h *Page) WithChecks(b *shot.Broker) *Page {
	h.shots = b
	return h
}

// CheckPage implements PageService: the host renders the page once and reports.
func (h *Page) CheckPage(ctx context.Context, req *connect.Request[v1.CheckPageRequest]) (*connect.Response[v1.CheckPageResponse], error) {
	if h.shots == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon checks no pages"))
	}
	m := req.Msg
	width, err := shotSize("width", m.GetWidth(), PageCheckWidth, shot.MinWidth, shot.MaxWidth)
	if err != nil {
		return nil, err
	}
	settle, err := checkSettle(m.GetSettleMs())
	if err != nil {
		return nil, err
	}
	a, err := h.store.Access(ctx, h.path(m.GetPath()))
	if err != nil {
		return nil, pageError(err)
	}
	thread, err := checkThread(a, m.GetThreadId())
	if err != nil {
		return nil, err
	}
	res, err := h.shots.Shoot(ctx, &v1.ShotRequest{Width: width, Height: PageCheckHeight, Page: &v1.PageShot{
		Path: a.Path, ThreadId: thread, SettleMs: int32(settle.Milliseconds()), Png: m.GetPng(),
	}})
	if err != nil {
		return nil, checkError(err)
	}
	return connect.NewResponse(&v1.CheckPageResponse{Report: res.PageReport, Png: res.PNG, Width: width, ThreadId: thread, Path: a.Path}), nil
}

// checkSettle is a check's settle bound: PageCheckSettle for 0, else ms within (0, PageCheckSettleMax].
func checkSettle(ms int32) (time.Duration, error) {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case ms == 0:
		return PageCheckSettle, nil
	case d < 0 || d > PageCheckSettleMax:
		return 0, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("settle %v is out of bounds (up to %v)", d, PageCheckSettleMax))
	}
	return d, nil
}

// checkThread is the thread the page acts for in a check: the asking thread when it owns
// the page, else its first owner, as a File tab does; "" for a page alone the user allowed.
// A page no thread owns and the user has not allowed has no bridge, and a check of it would
// only report that.
func checkThread(a page.Access, asking string) (string, error) {
	switch {
	case a.Owns(asking):
		return asking, nil
	case a.Owner != "":
		return a.Owner, nil
	case a.Consent == page.Allowed:
		return "", nil
	}
	return "", connect.NewError(connect.CodeFailedPrecondition,
		fmt.Errorf("no thread owns %s and the user has not allowed it, so it would run without Code Foundry; show it first (code-foundry view.inline)", a.Path))
}

// checkError is a check that got no report, as the CLI prints it.
func checkError(err error) error {
	switch {
	case errors.Is(err, shot.ErrNoCapturer):
		return connect.NewError(connect.CodeFailedPrecondition, ErrNoWindow)
	case errors.Is(err, shot.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, fmt.Errorf("not checked: %w", err))
	case errors.Is(err, shot.ErrGone), errors.Is(err, shot.ErrBusy):
		return connect.NewError(connect.CodeUnavailable, fmt.Errorf("not checked: %w", err))
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	}
	return connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("not checked: %w", err))
}
