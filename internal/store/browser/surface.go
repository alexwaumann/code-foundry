package browser

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// maxSurfaceKey bounds a surface's name, which the GUI makes from its panel's key.
const maxSurfaceKey = 256

// Viewport limits, in CSS pixels. A panel is never this big, and a screencast at twice it is
// as much as a frame should ever be.
const (
	minViewport     = 64
	maxViewport     = 4096
	defaultWidth    = 800
	defaultHeight   = 600
	deviceScale     = 2
	frameQuality    = 80
	maxDownloadList = 50
	castTries       = 10
	castRetry       = 100 * time.Millisecond
)

// Phase is where a surface is, for what its overlay says.
type Phase int

// The phases.
const (
	PhaseStarting Phase = iota
	PhaseReady
	PhaseUnavailable // Chrome cannot run: Message says why
	PhaseCrashed     // Chrome died: Relaunch
)

// Dialog is a page's alert, confirm, prompt or beforeunload waiting for an answer.
type Dialog struct {
	ID            string
	Kind, Message string
	DefaultPrompt string
	Origin        string
	Site          string // Origin's registrable domain, which a viewer keeps visible
}

// FileChooser is a page's file input waiting for files.
type FileChooser struct {
	ID       string
	Multiple bool
	Origin   string
	Site     string // Origin's registrable domain, which a viewer keeps visible

	node int64
}

// SelectOption is one row of a select.
type SelectOption struct {
	Label    string
	Disabled bool
}

// Select is a page's <select> the user opened; Chrome shows its popup nowhere a screencast
// can see, so the GUI draws the list.
type Select struct {
	ID       string
	Options  []SelectOption
	Selected int
	X, Y, W  float64 // where it sits in the page, CSS pixels

	context int64
}

// Download is one download of a surface.
type Download struct {
	ID, Name string
	Site     string // who asked for it, as a registrable domain; empty when nothing says
	Path     string // set once it completed
	State    string // one of the Download states
}

// State is what a surface's chrome shows. It holds what the page said, so a viewer treats
// every string here as the page's and renders it as text.
type State struct {
	Phase   Phase
	Message string

	URL, Title string
	// Site is the domain URL is registered under, and Security says what the page came over:
	// empty, SecurityInsecure or SecurityCert. Both are the daemon's reading, never the page's.
	Site, Security string
	Loading        bool
	CanGoBack      bool
	CanGoForward   bool
	Popup          bool

	Dialog      *Dialog
	FileChooser *FileChooser
	Select      *Select
	// Notice is the last thing the surface must say and has no better place for.
	Notice    string
	Downloads []Download
	// DownloadsBlocked counts refused downloads that did not fit in Downloads.
	DownloadsBlocked int
	// Copied counts the texts a page's own Copy button left; Copy with fromPage has the latest.
	Copied uint64
}

// What a page's address says about how it arrived.
const (
	SecurityInsecure = "insecure" // no encryption
	SecurityCert     = "cert"     // a certificate that failed, or an equal failure of the connection
)

// Frame is one screencast frame.
type Frame struct {
	JPEG []byte
	// Width and Height are the page's size in CSS pixels, which input coordinates use.
	Width, Height int

	ack  func()
	once sync.Once
}

// Taken acks the frame to Chrome, which then sends the next one. Safe to call twice.
func (f *Frame) Taken() {
	if f != nil && f.ack != nil {
		f.once.Do(f.ack)
	}
}

// Viewer is one stream's view of a surface.
type Viewer struct {
	store *Store
	sf    *surface
	wake  chan struct{}

	mu    sync.Mutex
	frame *Frame
	state *State
	err   error
}

// Wake fires when Take has something.
func (v *Viewer) Wake() <-chan struct{} { return v.wake }

// Take returns what changed since the last Take, the newest of each: the state, the frame,
// and the reason the view ended, which is final.
func (v *Viewer) Take() (*State, *Frame, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	st, f := v.state, v.frame
	v.state, v.frame = nil, nil
	return st, f, v.err
}

func (v *Viewer) ring() {
	select {
	case v.wake <- struct{}{}:
	default:
	}
}

// offerFrame replaces a frame not yet taken: only the newest matters. The replaced one is acked
// so Chrome goes on.
func (v *Viewer) offerFrame(f *Frame) {
	v.mu.Lock()
	old := v.frame
	v.frame = f
	v.mu.Unlock()
	old.Taken()
	v.ring()
}

func (v *Viewer) offerState(st State) {
	v.mu.Lock()
	v.state = &st
	v.mu.Unlock()
	v.ring()
}

func (v *Viewer) finish(err error) {
	v.mu.Lock()
	v.err = err
	old := v.frame
	v.frame = nil
	v.mu.Unlock()
	old.Taken()
	v.ring()
}

// surface is one panel tab's page. Its fields need Store.mu; up serialises bringing it up.
type surface struct {
	key     string
	store   *Store
	w, h    int
	viewers map[*Viewer]struct{}
	// stack is what the surface shows: its page, then the popups it opened. The last one
	// shows, and closing it comes back to the one before.
	stack   []*target
	pending string // the address to go to once there is a page
	state   State
	frame   *Frame // the last frame, for a viewer that arrives on a still page
	nextID  uint64
	// gesture is when the user last clicked or pressed Enter here, and a download spends it.
	gesture time.Time
	budget  struct {
		files int
		bytes int64
	}
	// copyArmed is a cmd+c or cmd+x that went to the page and Copy has not read yet. copied is
	// what a page's own Copy button left, waiting for the user's click on the strip.
	copyArmed bool
	copied    string

	up sync.Mutex
}

// top is the target showing, nil without one. Needs Store.mu.
func (sf *surface) top() *target {
	if len(sf.stack) == 0 {
		return nil
	}
	return sf.stack[len(sf.stack)-1]
}

// refresh brings the state up to the target showing. What a page asks belongs to its target: a
// viewer sees only what the page on screen asks, under that page's address. Needs Store.mu.
func (sf *surface) refresh() {
	sf.state.Dialog, sf.state.FileChooser, sf.state.Select = nil, nil, nil
	t := sf.top()
	if t == nil {
		return
	}
	// Both are the page's to make as long as it likes: a data: URL can be megabytes.
	sf.state.URL, sf.state.Title, sf.state.Loading = clip(shownURL(t.url), maxURL), clip(t.title, maxTitle), t.loading
	sf.state.Site, sf.state.Security = clip(siteOf(t.url), maxLabel), sf.security(t)
	sf.state.CanGoBack = t.canBack || len(sf.stack) > 1
	sf.state.CanGoForward = t.canForward
	sf.state.Popup = len(sf.stack) > 1
	sf.state.Dialog, sf.state.FileChooser, sf.state.Select = t.dialog, t.chooser, t.sel
}

// security reads how a page arrived. Only about:blank on the surface's own page is no page at
// all: in a popup, it is what an opener can write into. Needs Store.mu.
func (sf *surface) security(t *target) string {
	switch {
	case t.badCert:
		return SecurityCert
	case t.url == "", t.url == "about:blank" && len(sf.stack) <= 1:
		return ""
	case strings.HasPrefix(t.url, "https://"):
		return ""
	}
	return SecurityInsecure
}

// publish tells every viewer. Needs Store.mu.
func (sf *surface) publish() {
	sf.refresh()
	for v := range sf.viewers {
		// The rest of State is values or replaced whole; this list is updated in place.
		st := sf.state
		st.Downloads = slices.Clone(st.Downloads)
		v.offerState(st)
	}
}

// id numbers what a surface asks. Needs Store.mu.
func (sf *surface) id() string {
	sf.nextID++
	return fmt.Sprintf("%d", sf.nextID)
}

// detach forgets the targets of a Chrome that is gone. After a stop the address stays to come back
// to, if the address rule still passes it. After a crash it does not: going back to the page that
// ended Chrome would end it again, so the surface opens blank and says where it was. Needs Store.mu.
func (sf *surface) detach(crashed bool) {
	t := sf.top()
	if t != nil && t.url != "" && t.url != "about:blank" {
		if crashed {
			sf.state.Notice = crashWords(t.url)
		} else if u, err := CheckURL(t.url); err == nil && sf.pending == "" {
			sf.pending = u
		}
	}
	sf.stack = nil
	sf.state.Dialog, sf.state.FileChooser, sf.state.Select = nil, nil, nil
	sf.state.Loading = false
	sf.copyArmed = false
	sf.abandonDownloads()
}

// crashWords says what the surface did not go back to.
func crashWords(address string) string {
	if site := siteOf(address); site != "" {
		return "Chrome stopped on " + clip(site, maxLabel) + ", so that page was not opened again."
	}
	return "Chrome stopped on that page, so it was not opened again."
}

// end finishes every viewer. Needs Store.mu.
func (sf *surface) end(err error) {
	for v := range sf.viewers {
		v.finish(err)
	}
	sf.viewers = map[*Viewer]struct{}{}
}

// Watch opens a view of the named surface, creating it, and brings it up in the background:
// the viewer's first state says it is starting. width and height are the view's size. address,
// when set, is where to go: it comes with the view because an address for a panel nobody sees
// must start nothing. A refused address does not fail the view, which would end its stream for
// good: the surface says so instead.
func (s *Store) Watch(key string, width, height int, address string) (*Viewer, error) {
	if key == "" || len(key) > maxSurfaceKey {
		return nil, ErrNoSurface
	}
	first, refused := "", ""
	if address != "" {
		u, err := NormalizeURL(address)
		if err != nil {
			refused = err.Error()
		}
		first = u
	}
	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		return nil, ErrClosed
	case !s.opts.Enabled():
		s.mu.Unlock()
		return nil, ErrDisabled
	}
	sf := s.surfaces[key]
	if sf == nil {
		sf = &surface{key: key, store: s, w: defaultWidth, h: defaultHeight, viewers: map[*Viewer]struct{}{}}
		s.surfaces[key] = sf
	}
	sf.setSize(width, height)
	if first != "" {
		sf.pending = first
	}
	if refused != "" {
		sf.state.Notice = refused
	}
	v := &Viewer{store: s, sf: sf, wake: make(chan struct{}, 1)}
	sf.viewers[v] = struct{}{}
	s.viewers++
	s.stopIdleTimer()
	if s.crashed {
		sf.state.Phase, sf.state.Message = PhaseCrashed, "Chrome stopped unexpectedly."
	} else if sf.top() == nil {
		sf.state.Phase, sf.state.Message = PhaseStarting, ""
	}
	sf.refresh()
	st := sf.state
	st.Downloads = slices.Clone(st.Downloads)
	v.offerState(st)
	if sf.frame != nil {
		// The last frame, not its ack: a still page sends nothing new, and a stale ack is noise.
		v.offerFrame(&Frame{JPEG: sf.frame.JPEG, Width: sf.frame.Width, Height: sf.frame.Height})
	}
	crashed := s.crashed
	s.mu.Unlock()
	if !crashed {
		go s.bringUp(sf)
	}
	return v, nil
}

// Close ends the view. The last one out stops the screencast, and with no view anywhere the
// idle clock starts.
func (v *Viewer) Close() {
	s, sf := v.store, v.sf
	s.mu.Lock()
	if _, ok := sf.viewers[v]; !ok {
		s.mu.Unlock()
		return
	}
	delete(sf.viewers, v)
	s.viewers--
	last := len(sf.viewers) == 0
	t := sf.top()
	if s.viewers == 0 && !s.closed {
		s.startIdleTimer()
	}
	in := s.chrome
	s.mu.Unlock()
	v.finish(ErrClosed)
	if last && t != nil && in != nil {
		go s.stopCast(in, t)
	}
}

// setSize needs Store.mu.
func (sf *surface) setSize(w, h int) {
	if w >= minViewport && h >= minViewport && w <= maxViewport && h <= maxViewport {
		sf.w, sf.h = w, h
	}
}

// bringUp makes sure the surface has a page, on its address, and that a viewed one is being
// cast. Everything that needs a page goes through here.
func (s *Store) bringUp(sf *surface) {
	ctx := context.Background()
	sf.up.Lock()
	defer sf.up.Unlock()
	in, err := s.running(ctx)
	if err != nil {
		s.mu.Lock()
		if !errors.Is(err, ErrClosed) && !errors.Is(err, ErrDisabled) {
			if errors.Is(err, ErrCrashed) {
				sf.state.Phase = PhaseCrashed
			} else {
				sf.state.Phase = PhaseUnavailable
			}
			sf.state.Message = sentence(err)
			sf.publish()
		}
		s.mu.Unlock()
		return
	}
	s.mu.Lock()
	t := sf.top()
	s.mu.Unlock()
	if t == nil {
		if t, err = s.newPage(ctx, in, sf); err != nil {
			s.fail(sf, err)
			return
		}
	}
	s.mu.Lock()
	sf.state.Phase, sf.state.Message = PhaseReady, ""
	address := sf.pending
	sf.pending = ""
	cast := len(sf.viewers) > 0 && !t.casting
	sf.publish()
	s.mu.Unlock()
	if cast {
		if err := s.startCast(ctx, in, t); err != nil {
			s.log.Debug("screencast did not start", "err", err)
		}
	}
	if address != "" {
		// Not under the up lock: a slow site must not hold the surface's frames back.
		go func() {
			if err := s.goTo(ctx, in, t, address); err != nil {
				s.notice(sf, "Could not open that page.")
				s.log.Debug("navigate failed", "err", err)
			}
		}()
	}
}

func (s *Store) fail(sf *surface, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sf.state.Phase, sf.state.Message = PhaseUnavailable, sentence(err)
	sf.publish()
}

// sentence is an error as the surface says it.
func sentence(err error) string {
	s := err.Error()
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// notice shows one line on the surface.
func (s *Store) notice(sf *surface, text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sf.state.Notice = text
	sf.publish()
}

// newPage creates the surface's own page.
func (s *Store) newPage(ctx context.Context, in *instance, sf *surface) (*target, error) {
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err := in.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return nil, err
	}
	t := &target{id: created.TargetID}
	s.mu.Lock()
	t.surface = sf
	in.targets[t.id] = t
	s.mu.Unlock()
	if err := s.adopt(ctx, in, t); err != nil {
		return nil, err
	}
	s.mu.Lock()
	sf.stack = append(sf.stack, t)
	s.mu.Unlock()
	return t, nil
}

// adopt attaches to a target and turns on what a surface needs from it.
func (s *Store) adopt(ctx context.Context, in *instance, t *target) error {
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := in.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": t.id, "flatten": true}, &attached); err != nil {
		return err
	}
	s.mu.Lock()
	t.session = attached.SessionID
	in.sessions[t.session] = t
	s.mu.Unlock()
	steps := []struct {
		method string
		params any
	}{
		{"Page.enable", nil},
		// Only for the binding below, which does nothing without it (cdp.go).
		{"Runtime.enable", nil},
		// What says a certificate failed, on a page the user went on to anyway.
		{"Security.enable", nil},
		{"Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}},
		// A page that thinks it has no focus draws no caret and drops some key handling.
		{"Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true}},
		{"Runtime.addBinding", map[string]any{"name": helperBinding, "executionContextName": helperWorld}},
		{"Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": helperSource, "worldName": helperWorld, "runImmediately": true}},
	}
	for _, step := range steps {
		if err := in.call(ctx, t.session, step.method, step.params, nil); err != nil {
			return err
		}
	}
	return s.applySize(ctx, in, t)
}

// applySize makes the page the panel's size, so it reflows to it.
func (s *Store) applySize(ctx context.Context, in *instance, t *target) error {
	s.mu.Lock()
	w, h := t.surface.w, t.surface.h
	s.mu.Unlock()
	return in.call(ctx, t.session, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": w, "height": h, "deviceScaleFactor": deviceScale, "mobile": false, "screenWidth": w, "screenHeight": h,
	}, nil)
}

// startCast starts a target's frames, or restarts them for a new size or a new process. One at
// a time per target: a stop and a start from two callers would otherwise leave it stopped.
func (s *Store) startCast(ctx context.Context, in *instance, t *target) error {
	t.cast.Lock()
	defer t.cast.Unlock()
	s.mu.Lock()
	w, h := t.surface.w, t.surface.h
	again := t.casting
	t.casting = true
	s.mu.Unlock()
	if again {
		// A second start is refused, and a resize needs one for the new size.
		_ = in.call(ctx, t.session, "Page.stopScreencast", nil, nil)
	}
	var err error
	for try := 0; try < castTries; try++ {
		// During a move to another process Chrome answers "Not attached to an active page".
		err = in.call(ctx, t.session, "Page.startScreencast", map[string]any{
			"format": "jpeg", "quality": frameQuality, "everyNthFrame": 1, "maxWidth": w * deviceScale, "maxHeight": h * deviceScale,
		}, nil)
		if err == nil {
			break
		}
		select {
		case <-time.After(castRetry):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if err != nil {
		return err
	}
	go s.firstFrame(in, t, w, h)
	return nil
}

// firstFrame is what a still page would otherwise never send: a screencast only carries
// changes, so a view of a page that stopped changing would stay blank or stale.
func (s *Store) firstFrame(in *instance, t *target, w, h int) {
	var shot struct {
		Data string `json:"data"`
	}
	err := in.call(context.Background(), t.session, "Page.captureScreenshot", map[string]any{"format": "jpeg", "quality": frameQuality}, &shot)
	if err != nil {
		s.log.Debug("first frame", "err", err)
		return
	}
	jpeg, err := decodeFrame(shot.Data)
	if err != nil {
		return
	}
	f := &Frame{JPEG: jpeg, Width: w, Height: h}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.surface.top() != t {
		return
	}
	t.surface.frame = f
	for v := range t.surface.viewers {
		v.offerFrame(f)
	}
}

// stopCast stops the frames of a target unless a viewer came back meanwhile. Under the
// surface's up lock, so a viewer returning at this moment finds the cast in one state or the
// other and bringUp does the right thing.
func (s *Store) stopCast(in *instance, t *target) {
	t.surface.up.Lock()
	defer t.surface.up.Unlock()
	s.mu.Lock()
	keep := len(t.surface.viewers) > 0 && t.surface.top() == t
	if !keep {
		t.casting = false
	}
	s.mu.Unlock()
	if !keep {
		if err := in.call(context.Background(), t.session, "Page.stopScreencast", nil, nil); err != nil {
			s.log.Debug("stop screencast", "err", err)
		}
	}
}

// shown is a surface's Chrome and showing target, for a call that needs them.
func (s *Store) shown(key string) (*instance, *surface, *target, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.opts.Enabled() {
		return nil, nil, nil, ErrDisabled
	}
	sf := s.surfaces[key]
	if sf == nil {
		return nil, nil, nil, ErrNoSurface
	}
	if s.crashed {
		return nil, nil, nil, ErrCrashed
	}
	t := sf.top()
	if s.chrome == nil || t == nil {
		return nil, nil, nil, ErrNoSurface
	}
	return s.chrome, sf, t, nil
}

// Navigate goes to what the user typed or an agent asked for, after the address rule. An open
// dialog would hold the navigation, so it is dismissed first. It returns the address.
func (s *Store) Navigate(ctx context.Context, key, typed string) (string, error) {
	u, err := NormalizeURL(typed)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	sf := s.surfaces[key]
	starting := sf != nil && sf.top() == nil
	if starting {
		sf.pending = u
	}
	s.mu.Unlock()
	if starting {
		go s.bringUp(sf)
		return u, nil
	}
	in, sf, t, err := s.shown(key)
	if err != nil {
		return "", err
	}
	s.dismissDialog(ctx, in, t)
	s.mu.Lock()
	sf.newPageBudget()
	s.mu.Unlock()
	return u, s.goTo(ctx, in, t, u)
}

// newPageBudget starts a page's download limits over. Only for what the user asks: a page that
// navigates itself keeps counting. Needs Store.mu.
func (sf *surface) newPageBudget() {
	sf.budget.files, sf.budget.bytes = 0, 0
}

// goTo is the one place Page.navigate is called. u has passed NormalizeURL. It answers once the
// page starts to load, which a slow site can take a while to do.
func (s *Store) goTo(ctx context.Context, in *instance, t *target, u string) error {
	s.clearNotice(t)
	var res struct {
		ErrorText string `json:"errorText"`
	}
	ctx, cancel := context.WithTimeout(ctx, navigateTimeout)
	defer cancel()
	if err := in.conn.call(ctx, t.session, "Page.navigate", map[string]any{"url": u}, &res); err != nil {
		return err
	}
	if res.ErrorText != "" {
		if words := navigationWords(res.ErrorText); words != "" {
			s.notice(t.surface, words)
		}
	}
	return nil
}

// navigationWords says why a navigation failed, in the surface's words when it can do better
// than Chrome's code.
func navigationWords(code string) string {
	switch code {
	case "net::ERR_ABORTED":
		return "" // a navigation that became a download
	case "net::ERR_INVALID_AUTH_CREDENTIALS":
		return "This site asks for a user name and password, and this surface cannot ask for them yet."
	}
	return "Could not open that page: " + clip(code, maxLabel)
}

func (s *Store) clearNotice(t *target) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.surface.state.Notice != "" {
		t.surface.state.Notice = ""
		t.surface.publish()
	}
}

// dismissDialog answers a dialog in the way of a navigation. A page that loops on alerts can
// then still be left.
func (s *Store) dismissDialog(ctx context.Context, in *instance, t *target) {
	s.mu.Lock()
	open := t.dialog != nil
	t.dialog = nil
	s.mu.Unlock()
	if open {
		_ = in.call(ctx, t.session, "Page.handleJavaScriptDialog", map[string]any{"accept": false}, nil)
	}
}

// historyEntries is Page.getNavigationHistory's reply.
type historyEntries struct {
	CurrentIndex int `json:"currentIndex"`
	Entries      []struct {
		ID    int64  `json:"id"`
		URL   string `json:"url"`
		Title string `json:"title"`
	} `json:"entries"`
}

// canBack reports an entry to go back to. The about:blank a surface's page starts on is not
// one: going there would leave an empty surface with an empty address.
func (h historyEntries) canBack() bool {
	i := h.CurrentIndex - 1
	return i >= 0 && i < len(h.Entries) && h.Entries[i].URL != "about:blank"
}

// Go moves a surface through its history: -1 is back, 1 forward. Back from a popup's first
// page closes the popup, which is how the surface returns to what opened it.
func (s *Store) Go(ctx context.Context, key string, delta int) error {
	if delta != -1 && delta != 1 {
		return ErrBadInput
	}
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.dismissDialog(ctx, in, t)
	var h historyEntries
	if err := in.call(ctx, t.session, "Page.getNavigationHistory", nil, &h); err != nil {
		return err
	}
	i := h.CurrentIndex + delta
	if (delta > 0 && i < len(h.Entries)) || (delta < 0 && h.canBack()) {
		return in.call(ctx, t.session, "Page.navigateToHistoryEntry", map[string]any{"entryId": h.Entries[i].ID}, nil)
	}
	s.mu.Lock()
	popup := delta < 0 && len(sf.stack) > 1
	s.mu.Unlock()
	if popup {
		return in.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.id}, nil)
	}
	return nil
}

// Reload reloads the page showing.
func (s *Store) Reload(ctx context.Context, key string) error {
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.dismissDialog(ctx, in, t)
	s.clearNotice(t)
	s.mu.Lock()
	sf.newPageBudget()
	s.mu.Unlock()
	return in.call(ctx, t.session, "Page.reload", nil, nil)
}

// Resize follows the panel: the page reflows and the frames take the new size.
func (s *Store) Resize(ctx context.Context, key string, width, height int) error {
	s.mu.Lock()
	sf := s.surfaces[key]
	if sf != nil {
		sf.setSize(width, height)
	}
	s.mu.Unlock()
	in, _, t, err := s.shown(key)
	if err != nil {
		return nil // no page yet: the size waits for it
	}
	if err := s.applySize(ctx, in, t); err != nil {
		return err
	}
	s.mu.Lock()
	casting := t.casting
	s.mu.Unlock()
	if casting {
		return s.startCast(ctx, in, t)
	}
	return nil
}

// CloseSurface closes a tab's page and everything it opened.
func (s *Store) CloseSurface(ctx context.Context, key string) error {
	s.mu.Lock()
	sf := s.surfaces[key]
	if sf == nil {
		s.mu.Unlock()
		return nil
	}
	// Those views are over, and Viewer.Close will not find them to count them out.
	s.viewers -= len(sf.viewers)
	sf.end(ErrNoSurface)
	delete(s.surfaces, key)
	if s.viewers == 0 && !s.closed {
		s.startIdleTimer()
	}
	in := s.chrome
	stack := sf.stack
	sf.stack = nil
	if in != nil {
		for guid, d := range in.downloads {
			if d.sf == sf && !d.allowed {
				s.cancelDownload(in, guid, d)
			}
		}
	}
	s.mu.Unlock()
	if in != nil {
		for _, t := range stack {
			_ = in.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.id}, nil)
		}
	}
	return nil
}

// AnswerDialog answers the dialog id of the page on screen, the only one that can have one.
func (s *Store) AnswerDialog(ctx context.Context, key, id string, accept bool, text string) error {
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	d := t.dialog
	if d == nil || d.ID != id {
		s.mu.Unlock()
		return ErrNotPending
	}
	t.dialog = nil
	sf.publish()
	s.mu.Unlock()
	return in.call(ctx, t.session, "Page.handleJavaScriptDialog", map[string]any{"accept": accept, "promptText": text}, nil)
}

// AnswerFile hands a page's file input the files the user picked, none to cancel.
func (s *Store) AnswerFile(ctx context.Context, key, id string, paths []string) error {
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	fc := t.chooser
	if fc == nil || fc.ID != id {
		s.mu.Unlock()
		return ErrNotPending
	}
	t.chooser = nil
	sf.publish()
	s.mu.Unlock()
	if len(paths) == 0 {
		return nil
	}
	if len(paths) > 1 && !fc.Multiple {
		return ErrNotPending
	}
	for _, p := range paths {
		if st, err := os.Stat(p); !filepath.IsAbs(p) || err != nil || !st.Mode().IsRegular() {
			return fmt.Errorf("not a file: %s", filepath.Base(p))
		}
	}
	return in.call(ctx, t.session, "DOM.setFileInputFiles", map[string]any{"files": paths, "backendNodeId": fc.node}, nil)
}

// PickSelect answers an opened <select>: an index of its options, or -1 for none.
func (s *Store) PickSelect(ctx context.Context, key, id string, index int) error {
	in, sf, t, err := s.shown(key)
	if err != nil {
		return err
	}
	s.mu.Lock()
	sel := t.sel
	if sel == nil || sel.ID != id {
		s.mu.Unlock()
		return ErrNotPending
	}
	t.sel = nil
	sf.publish()
	s.mu.Unlock()
	if index < 0 || index >= len(sel.Options) {
		return nil
	}
	return in.call(ctx, t.session, "Runtime.evaluate", map[string]any{
		"contextId": sel.context, "expression": fmt.Sprintf("%s(%d)", helperPick, index),
	}, nil)
}

// DismissNotice clears the surface's line.
func (s *Store) DismissNotice(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sf := s.surfaces[key]; sf != nil {
		sf.state.Notice = ""
		sf.publish()
	}
}

// RevealDownload shows a finished download in Finder: only what Chrome reported into the
// downloads folder, whatever the id came with.
func (s *Store) RevealDownload(key, id string) error {
	s.mu.Lock()
	sf := s.surfaces[key]
	var path string
	if sf != nil {
		for _, d := range sf.state.Downloads {
			if d.ID == id {
				path = d.Path
			}
		}
	}
	s.mu.Unlock()
	if path == "" {
		return ErrNotPending
	}
	if rel, err := filepath.Rel(s.Downloads(), path); err != nil || strings.HasPrefix(rel, "..") {
		return ErrNotPending
	}
	return s.opts.Reveal(path)
}

// decodeFrame reads a frame's data.
func decodeFrame(data string) ([]byte, error) { return base64.StdEncoding.DecodeString(data) }

// originOf is what a viewer is told asked: never the path, which may hold tokens.
func originOf(raw string) string {
	u, err := url.Parse(shownURL(raw))
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
