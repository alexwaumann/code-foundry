package main

import (
	"log/slog"
	"math"
	"sync"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The dictation overlay (docs/notes/dictate-anywhere-overlay.md): the plate under the menu
// bar that shows a session started outside the app listening, working and done. The host
// only places, shows and hides the window; the page (frontend/dictation-overlay.html) reads
// the daemon and plays the phases. The plate's dimensions come from Hex
// (anomalyco/hex, MIT; the notice is in frontend/public/HEX-LICENSE.md).

const (
	// overlayClientID is the DictationSession.client_id the overlay shows for. Composers
	// make their own ids and the CLI says "cli", so nothing else ever shows it.
	overlayClientID = "system"
	// EventOverlayBegin tells the page a session to play; data is its id. The page
	// (src/api/overlay.ts) holds no stream until then.
	EventOverlayBegin = "dictation-overlay:begin"
	// overlayLinger is how long the page has, once the session is gone, to ask for the hide
	// (it needs under 1 s). A page that died must not leave the window up.
	overlayLinger = 3 * time.Second

	// overlayPlateHeight and overlayPlateGap: the plate, and its gap under the menu bar.
	overlayPlateHeight = 26.0
	overlayPlateGap    = 6.0
	// overlayWindowWidth and overlayWindowHeight hold the 112 pt plate with its overshoot
	// and its shadow (10 pt blur, 3 pt down). The plate sits in the window's middle, so the
	// page needs no position from the host.
	overlayWindowWidth  = 144.0
	overlayWindowHeight = 52.0
)

// overlayRect is a rectangle in AppKit's screen space: points, y up, the origin at its
// bottom left.
type overlayRect struct {
	X, Y, Width, Height float64
}

func (r overlayRect) top() float64 { return r.Y + r.Height }

// overlayScreen is one NSScreen.
type overlayScreen struct {
	Frame   overlayRect
	Visible overlayRect
	// SafeTop is safeAreaInsets.top: the notch's height, 0 on a flat screen.
	SafeTop float64
}

// overlayScreenAt is the screen with the pointer, else the first (the primary).
// NSEvent.mouseLocation's y runs up to and including a screen's top, so the top edge
// belongs to the screen. screens must not be empty.
func overlayScreenAt(screens []overlayScreen, x, y float64) overlayScreen {
	for _, s := range screens {
		f := s.Frame
		if x >= f.X && x < f.X+f.Width && y >= f.Y && y <= f.top() {
			return s
		}
	}
	return screens[0]
}

// overlayFrame is the window's frame on screen: centred, the plate overlayPlateGap under
// the menu bar. Under the notch too where a full-screen space hides the menu bar and
// visibleFrame reaches the top of a notched screen. Whole points, so the plate does not
// land between pixels on a 1x display.
func overlayFrame(s overlayScreen) overlayRect {
	plateTop := math.Min(s.Visible.top(), s.Frame.top()-s.SafeTop) - overlayPlateGap
	middle := plateTop - overlayPlateHeight/2
	return overlayRect{
		X:      math.Round(s.Frame.X + (s.Frame.Width-overlayWindowWidth)/2),
		Y:      math.Round(middle - overlayWindowHeight/2),
		Width:  overlayWindowWidth,
		Height: overlayWindowHeight,
	}
}

// overlaySession is the session the overlay shows for in s ("" for none).
func overlaySession(s *v1.DictationSnapshot) string {
	if s.GetState() != v1.DictationState_DICTATION_STATE_LISTENING || s.GetSession().GetClientId() != overlayClientID {
		return ""
	}
	return s.GetSession().GetId()
}

// overlayPanel is the window (overlayWindow; a fake in tests). show puts it on the
// pointer's screen and hands the page the session.
type overlayPanel interface {
	show(sessionID string)
	hide()
}

// OverlayService is bound to the overlay page. The dictation watcher tells it what the
// daemon says (observe, lost), the page says when it has finished (PageDone), and it
// decides when the window shows and hides.
type OverlayService struct {
	log *slog.Logger
	// panel is set by main before the watcher starts.
	panel overlayPanel
	// after runs fn after d and returns what cancels it (time.AfterFunc; a fake in tests).
	after func(d time.Duration, fn func()) (cancel func())

	mu sync.Mutex
	// session is the last session shown, kept after it hides so a reconnecting watcher
	// does not show it again.
	session string
	visible bool
	// cancelLinger is set while the linger clock runs.
	cancelLinger func()
}

// NewOverlayService returns the service; set panel before use.
func NewOverlayService(log *slog.Logger) *OverlayService {
	return &OverlayService{log: log, after: func(d time.Duration, fn func()) func() {
		t := time.AfterFunc(d, fn)
		return func() { t.Stop() }
	}}
}

// observe takes a snapshot (not a heartbeat) from DictationService.Watch.
func (o *OverlayService) observe(s *v1.DictationSnapshot) {
	id := overlaySession(s)
	o.mu.Lock()
	defer o.mu.Unlock()
	switch {
	case id == "":
		o.armLingerLocked()
	case id != o.session:
		o.stopLingerLocked()
		o.session, o.visible = id, true
		o.log.Info("dictation overlay: showing", "session", id)
		o.panel.show(id)
	default:
		// The same session again (a reconnect): the page has it, or has finished with it.
		o.stopLingerLocked()
	}
}

// lost is the Watch stream ending: the daemon may never say the session ended.
func (o *OverlayService) lost() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.armLingerLocked()
}

// armLingerLocked starts the clock that hides a window the page has not hidden.
func (o *OverlayService) armLingerLocked() {
	if !o.visible || o.cancelLinger != nil {
		return
	}
	session := o.session
	o.cancelLinger = o.after(overlayLinger, func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		if o.session != session || !o.visible {
			return
		}
		o.log.Warn("dictation overlay: the page did not finish; hiding", "session", session)
		o.hideLocked()
	})
}

func (o *OverlayService) stopLingerLocked() {
	if o.cancelLinger != nil {
		o.cancelLinger()
		o.cancelLinger = nil
	}
}

func (o *OverlayService) hideLocked() {
	o.stopLingerLocked()
	o.visible = false
	o.panel.hide()
}

// PageReady is the page, just loaded, asking for a session shown before it could hear
// EventOverlayBegin ("" for none). The window is created on the first session, so that
// session always comes this way.
func (o *OverlayService) PageReady() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.visible {
		return ""
	}
	return o.session
}

// PageDone is the page having finished with a session: the window hides, unless a newer
// session has taken it.
func (o *OverlayService) PageDone(sessionID string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if sessionID != o.session || !o.visible {
		return
	}
	o.hideLocked()
}
