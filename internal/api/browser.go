package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/browser"
)

// BrowserStore is the browser store (*browser.Store) as BrowserService drives it.
type BrowserStore interface {
	Watch(surface string, width, height int, address string) (*browser.Viewer, error)
	Navigate(ctx context.Context, surface, typed string) (string, error)
	Go(ctx context.Context, surface string, delta int) error
	Reload(ctx context.Context, surface string) error
	Input(ctx context.Context, surface string, events []browser.InputEvent) error
	Resize(ctx context.Context, surface string, width, height int) error
	AnswerDialog(ctx context.Context, surface, id string, accept bool, text string) error
	AnswerFile(ctx context.Context, surface, id string, paths []string) error
	PickSelect(ctx context.Context, surface, id string, index int) error
	Paste(ctx context.Context, surface, text string) error
	Copy(ctx context.Context, surface string, fromPage bool) (int, error)
	AnswerDownload(ctx context.Context, surface, id string, allow bool) error
	RevealDownload(surface, id string) error
	Relaunch(ctx context.Context) error
	CloseSurface(ctx context.Context, surface string) error
}

var _ BrowserStore = (*browser.Store)(nil)

// frameFlushDelay is the silence after a frame before a small heartbeat follows it: WKWebView
// can hold the end of a large message until more bytes arrive (snapshotFlushes), and on a still
// page the last frame is the one that would wait. A page that keeps painting never gets here.
const frameFlushDelay = 20 * time.Millisecond

// Browser implements codefoundryv1connect.BrowserServiceHandler over the browser store
// (docs/notes/chrome-surface.md).
type Browser struct {
	codefoundryv1connect.UnimplementedBrowserServiceHandler
	store BrowserStore
	beat  time.Duration // heartbeat interval; zero is HeartbeatInterval (tests shorten it)
}

var _ codefoundryv1connect.BrowserServiceHandler = (*Browser)(nil)

// NewBrowser returns a BrowserService handler.
func NewBrowser(store BrowserStore) *Browser { return &Browser{store: store} }

// Route mounts the service for browser pages only: a request must carry one Origin that allow
// accepts, which the GUI's always does and the CLI's never. What it stops is every client built
// on the daemon's API, the Unix socket included, reaching a logged-in browser by accident or
// by a verb nobody wrote. The bearer check still runs behind it. It is no wall against a
// program that holds the token and forges the header, and neither is anything else: such a
// program runs as this user and could read the profile from disk.
func (h *Browser) Route(allow func(origin string) bool, opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewBrowserServiceHandler(h, opts...)
	return Route{Path: path, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origins := r.Header.Values("Origin")
		if len(origins) != 1 || !allow(origins[0]) {
			http.Error(w, "the browser surface answers the window only", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})}
}

// Watch streams a surface's state and frames, and a heartbeat when both are quiet.
func (h *Browser) Watch(ctx context.Context, req *connect.Request[v1.WatchBrowserRequest], stream *connect.ServerStream[v1.BrowserEvent]) error {
	m := req.Msg
	view, err := h.store.Watch(m.GetSurface(), int(m.GetWidth()), int(m.GetHeight()), m.GetUrl())
	if err != nil {
		return browserError(err)
	}
	defer view.Close()
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	flush := time.NewTimer(time.Hour)
	flush.Stop()
	defer flush.Stop()
	heartbeat := func() error {
		beat.Reset()
		return stream.Send(&v1.BrowserEvent{Event: &v1.BrowserEvent_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}})
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-beat.C():
			if err := heartbeat(); err != nil {
				return err
			}
		case <-flush.C:
			if err := heartbeat(); err != nil {
				return err
			}
		case <-view.Wake():
			state, frame, ended := view.Take()
			if state != nil {
				if err := stream.Send(&v1.BrowserEvent{Event: &v1.BrowserEvent_State{State: browserStateToProto(state)}}); err != nil {
					return err
				}
				beat.Reset()
			}
			if frame != nil {
				err := stream.Send(&v1.BrowserEvent{Event: &v1.BrowserEvent_Frame{Frame: &v1.BrowserFrame{
					Jpeg: frame.JPEG, Width: uint32(frame.Width), Height: uint32(frame.Height), //nolint:gosec // a viewport's size
				}}})
				// After the send, not before: a client that cannot take frames holds Chrome
				// back here, instead of frames piling up behind it.
				frame.Taken()
				if err != nil {
					return err
				}
				beat.Reset()
				flush.Reset(frameFlushDelay)
			}
			if ended != nil {
				return browserError(ended)
			}
		}
	}
}

// Navigate goes to an address.
func (h *Browser) Navigate(ctx context.Context, req *connect.Request[v1.NavigateBrowserRequest]) (*connect.Response[v1.NavigateBrowserResponse], error) {
	u, err := h.store.Navigate(ctx, req.Msg.GetSurface(), req.Msg.GetUrl())
	if err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.NavigateBrowserResponse{Url: u}), nil
}

// Go moves through the history.
func (h *Browser) Go(ctx context.Context, req *connect.Request[v1.GoBrowserRequest]) (*connect.Response[v1.GoBrowserResponse], error) {
	if err := h.store.Go(ctx, req.Msg.GetSurface(), int(req.Msg.GetDelta())); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.GoBrowserResponse{}), nil
}

// Reload reloads the page.
func (h *Browser) Reload(ctx context.Context, req *connect.Request[v1.ReloadBrowserRequest]) (*connect.Response[v1.ReloadBrowserResponse], error) {
	if err := h.store.Reload(ctx, req.Msg.GetSurface()); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.ReloadBrowserResponse{}), nil
}

// Input forwards events to the page.
func (h *Browser) Input(ctx context.Context, req *connect.Request[v1.BrowserInputRequest]) (*connect.Response[v1.BrowserInputResponse], error) {
	events := make([]browser.InputEvent, 0, len(req.Msg.GetEvents()))
	for _, e := range req.Msg.GetEvents() {
		events = append(events, browserInputFromProto(e))
	}
	if err := h.store.Input(ctx, req.Msg.GetSurface(), events); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.BrowserInputResponse{}), nil
}

// Resize sets the page's size.
func (h *Browser) Resize(ctx context.Context, req *connect.Request[v1.ResizeBrowserRequest]) (*connect.Response[v1.ResizeBrowserResponse], error) {
	m := req.Msg
	if err := h.store.Resize(ctx, m.GetSurface(), int(m.GetWidth()), int(m.GetHeight())); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.ResizeBrowserResponse{}), nil
}

// Answer answers what a page is asking.
func (h *Browser) Answer(ctx context.Context, req *connect.Request[v1.AnswerBrowserRequest]) (*connect.Response[v1.AnswerBrowserResponse], error) {
	m := req.Msg
	var err error
	switch a := m.GetAnswer().(type) {
	case *v1.AnswerBrowserRequest_Dialog:
		err = h.store.AnswerDialog(ctx, m.GetSurface(), m.GetId(), a.Dialog.GetAccept(), a.Dialog.GetText())
	case *v1.AnswerBrowserRequest_Files:
		err = h.store.AnswerFile(ctx, m.GetSurface(), m.GetId(), a.Files.GetPaths())
	case *v1.AnswerBrowserRequest_Option:
		err = h.store.PickSelect(ctx, m.GetSurface(), m.GetId(), int(a.Option))
	case *v1.AnswerBrowserRequest_Download:
		err = h.store.AnswerDownload(ctx, m.GetSurface(), m.GetId(), a.Download)
	default:
		err = browser.ErrNotPending
	}
	if err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.AnswerBrowserResponse{}), nil
}

// Paste pastes the user's text.
func (h *Browser) Paste(ctx context.Context, req *connect.Request[v1.PasteBrowserRequest]) (*connect.Response[v1.PasteBrowserResponse], error) {
	if err := h.store.Paste(ctx, req.Msg.GetSurface(), req.Msg.GetText()); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.PasteBrowserResponse{}), nil
}

// Copy moves the user's copy to the Mac's clipboard.
func (h *Browser) Copy(ctx context.Context, req *connect.Request[v1.CopyBrowserRequest]) (*connect.Response[v1.CopyBrowserResponse], error) {
	n, err := h.store.Copy(ctx, req.Msg.GetSurface(), req.Msg.GetPageCopy())
	if err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.CopyBrowserResponse{Length: uint32(n)}), nil //nolint:gosec // a text's length
}

// Reveal shows a download in Finder.
func (h *Browser) Reveal(_ context.Context, req *connect.Request[v1.RevealBrowserDownloadRequest]) (*connect.Response[v1.RevealBrowserDownloadResponse], error) {
	if err := h.store.RevealDownload(req.Msg.GetSurface(), req.Msg.GetId()); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.RevealBrowserDownloadResponse{}), nil
}

// Relaunch starts Chrome again.
func (h *Browser) Relaunch(ctx context.Context, _ *connect.Request[v1.RelaunchBrowserRequest]) (*connect.Response[v1.RelaunchBrowserResponse], error) {
	if err := h.store.Relaunch(ctx); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.RelaunchBrowserResponse{}), nil
}

// Close closes a surface's page.
func (h *Browser) Close(ctx context.Context, req *connect.Request[v1.CloseBrowserRequest]) (*connect.Response[v1.CloseBrowserResponse], error) {
	if err := h.store.CloseSurface(ctx, req.Msg.GetSurface()); err != nil {
		return nil, browserError(err)
	}
	return connect.NewResponse(&v1.CloseBrowserResponse{}), nil
}

var browserPhases = map[browser.Phase]v1.BrowserPhase{
	browser.PhaseStarting:    v1.BrowserPhase_BROWSER_PHASE_STARTING,
	browser.PhaseReady:       v1.BrowserPhase_BROWSER_PHASE_READY,
	browser.PhaseUnavailable: v1.BrowserPhase_BROWSER_PHASE_UNAVAILABLE,
	browser.PhaseCrashed:     v1.BrowserPhase_BROWSER_PHASE_CRASHED,
}

func browserStateToProto(s *browser.State) *v1.BrowserState {
	out := &v1.BrowserState{
		Phase: browserPhases[s.Phase], Message: s.Message, Url: s.URL, Title: s.Title, Loading: s.Loading,
		CanGoBack: s.CanGoBack, CanGoForward: s.CanGoForward, Popup: s.Popup, Notice: s.Notice, Copied: s.Copied,
		Site: s.Site, Security: s.Security, DownloadsBlocked: uint32(s.DownloadsBlocked), //nolint:gosec // a count
	}
	if d := s.Dialog; d != nil {
		out.Dialog = &v1.BrowserDialog{Id: d.ID, Kind: d.Kind, Message: d.Message, DefaultPrompt: d.DefaultPrompt, Origin: d.Origin, Site: d.Site}
	}
	if f := s.FileChooser; f != nil {
		out.FileChooser = &v1.BrowserFileChooser{Id: f.ID, Multiple: f.Multiple, Origin: f.Origin, Site: f.Site}
	}
	if sel := s.Select; sel != nil {
		p := &v1.BrowserSelect{Id: sel.ID, Selected: int32(sel.Selected), X: sel.X, Y: sel.Y, Width: sel.W} //nolint:gosec // an option's index
		for _, o := range sel.Options {
			p.Options = append(p.Options, &v1.BrowserSelectOption{Label: o.Label, Disabled: o.Disabled})
		}
		out.Select = p
	}
	for _, d := range s.Downloads {
		out.Downloads = append(out.Downloads, &v1.BrowserDownload{Id: d.ID, Name: d.Name, State: d.State, Site: d.Site})
	}
	return out
}

func browserInputFromProto(e *v1.BrowserInputEvent) browser.InputEvent {
	switch ev := e.GetEvent().(type) {
	case *v1.BrowserInputEvent_Mouse:
		m := ev.Mouse
		return browser.InputEvent{Mouse: &browser.MouseEvent{
			Type: m.GetType(), Button: m.GetButton(), X: m.GetX(), Y: m.GetY(), Buttons: int(m.GetButtons()),
			ClickCount: int(m.GetClickCount()), Modifiers: int(m.GetModifiers()), DeltaX: m.GetDeltaX(), DeltaY: m.GetDeltaY(),
		}}
	case *v1.BrowserInputEvent_Key:
		k := ev.Key
		return browser.InputEvent{Key: &browser.KeyEvent{
			Type: k.GetType(), Key: k.GetKey(), Code: k.GetCode(), Text: k.GetText(), KeyCode: int(k.GetKeyCode()),
			Modifiers: int(k.GetModifiers()), Location: int(k.GetLocation()), AutoRepeat: k.GetAutoRepeat(),
		}}
	case *v1.BrowserInputEvent_Text:
		return browser.InputEvent{Text: ev.Text}
	}
	return browser.InputEvent{}
}

func browserError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, browser.ErrBadURL), errors.Is(err, browser.ErrBadInput):
		code = connect.CodeInvalidArgument
	case errors.Is(err, browser.ErrNoSurface), errors.Is(err, browser.ErrNotPending):
		code = connect.CodeNotFound
	case errors.Is(err, browser.ErrDisabled), errors.Is(err, browser.ErrCrashed):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, browser.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}
