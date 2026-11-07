package browser

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"
)

// target is one page in Chrome: a surface's own, or a popup it opened. Its fields need
// Store.mu.
type target struct {
	id, session string
	surface     *surface
	// url is the page committed in its main frame and nothing else: not a subframe's, not where
	// a navigation is headed, which an opener could write under.
	url, title string
	// origin is Chrome's securityOrigin for that commit, empty when opaque. A page cannot change it
	// with history.pushState, and a blank page inherits it from whoever made it.
	origin string
	// commits counts the main frame's commits, so what was read before one is known to be stale.
	// documents counts only those that made a new document, not a pushState.
	commits, documents int
	// visited is this page having been anything but the blank it started on: a blank that is no
	// page has nothing on it, and any other blank is what someone wrote into.
	visited bool
	// popup is a page another one opened. Its blank is never the start of a surface, even once its
	// opener has gone.
	popup bool
	// unpainted is a page that has sent no frame since it became another site's, or came on
	// screen: what the surface last drew is someone else's, and a viewer covers it.
	unpainted  bool
	loading    bool
	canBack    bool
	canForward bool
	casting    bool
	badCert    bool
	// What this page is asking. A viewer sees it only while this page shows (surface.refresh).
	dialog  *Dialog
	chooser *FileChooser
	sel     *Select
	cast    sync.Mutex // held across a start or restart of the frames
	// press is where the user last pressed, for a select in an iframe (select.go).
	pressX, pressY float64
	// frames counts the cross-site iframes with a session (frames.go).
	frames int
	queue  workQueue
	budget eventBudget
	// history counts the entries this page pushed lately: the state of each one is kept in
	// Chrome's own process (pacing.go, blameHistory).
	history historyPushes
}

// shownOrigin is who a page is: Chrome's word, or what its address says while there is none yet.
func (t *target) shownOrigin() string {
	if t.origin != "" {
		return t.origin
	}
	return originOf(t.url)
}

// commit takes what the main frame committed. Needs Store.mu.
func (t *target) commit(address, origin string) {
	was := t.shownOrigin()
	t.url, t.origin = address, origin
	t.commits++
	t.documents++
	if now := t.shownOrigin(); now != was || now == "" {
		t.unpainted = true
		if t.surface.top() == t {
			t.surface.dropFrame()
		}
	}
	if address != "about:blank" || origin != "" {
		t.visited = true
	}
}

// committed asks for what a commit leaves to read. Needs Store.mu.
func (s *Store) committed(in *instance, t *target, j job) {
	if t.origin == "" {
		j |= jobOrigin
	}
	s.schedule(in, t, j)
}

// handlers are the events a surface follows, by method. A handler runs on the connection's
// reader with Store.mu held, so it never makes a call; what needs one runs in a goroutine.
// Filled by init: the handlers reach the launch, which reaches these tables.
var handlers map[string]func(s *Store, in *instance, t *target, params json.RawMessage)

// browserHandlers are the events of the browser itself, which arrive with no session.
var browserHandlers map[string]func(s *Store, in *instance, params json.RawMessage)

// frameHandlers are what a cross-site iframe's own session reports (frames.go).
var frameHandlers map[string]func(s *Store, in *instance, f *frame, params json.RawMessage)

func init() {
	handlers = map[string]func(s *Store, in *instance, t *target, params json.RawMessage){
		"Page.frameNavigated":                  onFrameNavigated,
		"Page.documentOpened":                  onFrameNavigated,
		"Page.navigatedWithinDocument":         onWithinDocument,
		"Page.frameStartedLoading":             onLoading(true),
		"Page.frameStoppedLoading":             onLoading(false),
		"Page.javascriptDialogOpening":         onDialogOpening,
		"Page.javascriptDialogClosed":          onDialogClosed,
		"Page.fileChooserOpened":               onFileChooser,
		"Page.downloadWillBegin":               onPageDownload,
		"Security.visibleSecurityStateChanged": onSecurityState,
		"Page.frameStartedNavigating":          onFrameStartedNavigating,
		"Target.attachedToTarget":              onFrameAttached,
		"Target.detachedFromTarget":            onFrameDetached,
	}
	frameHandlers = map[string]func(s *Store, in *instance, f *frame, params json.RawMessage){
		"Page.frameNavigated":         onSubframeNavigated,
		"Page.fileChooserOpened":      onSubframeChooser,
		"Page.downloadWillBegin":      onSubframeDownload,
		"Page.frameStartedNavigating": onNestedFrameStartedNavigating,
		"Target.attachedToTarget":     onNestedFrameAttached,
		"Target.detachedFromTarget":   onNestedFrameDetached,
	}
	browserHandlers = map[string]func(s *Store, in *instance, params json.RawMessage){
		"Target.targetCreated":      onTargetCreated,
		"Target.targetDestroyed":    onTargetDestroyed,
		"Target.targetCrashed":      onTargetCrashed,
		"Target.targetInfoChanged":  onTargetInfoChanged,
		"Browser.downloadWillBegin": onBrowserDownload,
		"Browser.downloadProgress":  onDownloadProgress,
	}
}

// event routes one event. Frames skip the lock's other users as far as they can: they are
// what the connection carries most.
func (s *Store) event(in *instance, method, session string, params json.RawMessage) {
	if method == "Page.screencastFrame" {
		s.onFrame(in, session, params)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if session == "" {
		if h := browserHandlers[method]; h != nil {
			h(s, in, params)
		}
		return
	}
	if t := in.sessions[session]; t != nil {
		if h := handlers[method]; s.charge(in, t, len(params)) && h != nil {
			h(s, in, t, params)
		}
		return
	}
	if f := in.frames[session]; f != nil {
		if h := frameHandlers[method]; s.charge(in, f.owner, len(params)) && h != nil {
			h(s, in, f, params)
		}
	}
}

// onFrame hands a frame to the viewers of the target showing, or acks it away.
func (s *Store) onFrame(in *instance, session string, params json.RawMessage) {
	var p struct {
		Data     string `json:"data"`
		Session  int64  `json:"sessionId"`
		Metadata struct {
			DeviceWidth  float64 `json:"deviceWidth"`
			DeviceHeight float64 `json:"deviceHeight"`
		} `json:"metadata"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	ack := func() { in.conn.post(session, "Page.screencastFrameAck", map[string]any{"sessionId": p.Session}) }
	jpeg, err := decodeFrame(p.Data)
	if err != nil {
		ack()
		return
	}
	f := &Frame{JPEG: jpeg, Width: int(p.Metadata.DeviceWidth), Height: int(p.Metadata.DeviceHeight), ack: ack}
	s.mu.Lock()
	defer s.mu.Unlock()
	t := in.sessions[session]
	if t == nil || t.surface.top() != t || len(t.surface.viewers) == 0 {
		ack()
		return
	}
	t.painted()
	t.surface.frame = f
	for v := range t.surface.viewers {
		v.offerFrame(f)
	}
}

type frameParams struct {
	Frame struct {
		ID          string `json:"id"`
		ParentID    string `json:"parentId"`
		URL         string `json:"url"`
		Unreachable string `json:"unreachableUrl"`
		MimeType    string `json:"mimeType"`
		Origin      string `json:"securityOrigin"`
	} `json:"frame"`
}

func onFrameNavigated(s *Store, in *instance, t *target, params json.RawMessage) {
	var p frameParams
	if json.Unmarshal(params, &p) != nil || p.Frame.ParentID != "" {
		return
	}
	if p.Frame.Unreachable != "" {
		// On an error page the address is the one that failed, as in any browser, not
		// chrome-error://chromewebdata/.
		t.commit(p.Frame.Unreachable, originOf(p.Frame.Unreachable))
	} else {
		t.commit(p.Frame.URL, chromeOrigin(p.Frame.Origin))
	}
	if !allowedPage(p.Frame.URL) || p.Frame.MimeType == "application/pdf" {
		// Chrome keeps pages off these on its own, and makes a PDF a download
		// (plugins.always_open_pdf_externally). If one ever got here it does not stay: a PDF would
		// be Chrome's viewer, with Download and Print buttons of its own.
		t.surface.state.Notice = "That page is not allowed here."
		s.log.Warn("left a page a surface may not show")
		go func() {
			_ = in.call(context.Background(), t.session, "Page.navigate", map[string]any{"url": "about:blank"}, nil)
		}()
	}
	t.sel, t.chooser = nil, nil
	// A new document has none of the old one's frames. Chrome does not always say so for a frame
	// inside a frame, and one left counted holds a place under maxFrames for good.
	in.forgetFrames(t)
	if t.surface.top() == t {
		t.surface.leftPage()
	}
	t.surface.publish()
	// A navigation can move the page to another process, and a cast asked for during the move is
	// refused ("Not attached to an active page"). This one always lands.
	s.committed(in, t, jobHistory|jobCast)
}

// onWithinDocument is history.pushState and the like. A subframe can do it too, and its address
// is not the page's; a target's main frame has the target's id.
func onWithinDocument(s *Store, in *instance, t *target, params json.RawMessage) {
	var p struct {
		FrameID string `json:"frameId"`
		URL     string `json:"url"`
	}
	if json.Unmarshal(params, &p) != nil || p.FrameID != t.id {
		return
	}
	t.url = p.URL
	t.commits++
	t.history.push(time.Now())
	t.surface.publish()
	s.schedule(in, t, jobHistory)
}

// refreshHistory reads whether back and forward have anywhere to go.
func (s *Store) refreshHistory(in *instance, t *target) {
	var h historyEntries
	if err := in.call(context.Background(), t.session, "Page.getNavigationHistory", nil, &h); err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t.canBack, t.canForward = h.canBack(), h.CurrentIndex < len(h.Entries)-1
	if h.CurrentIndex >= 0 && h.CurrentIndex < len(h.Entries) {
		t.title = h.Entries[h.CurrentIndex].Title
	}
	t.surface.publish()
}

func onLoading(loading bool) func(*Store, *instance, *target, json.RawMessage) {
	return func(s *Store, in *instance, t *target, params json.RawMessage) {
		var p struct {
			FrameID string `json:"frameId"`
		}
		// A target's main frame has the target's id.
		if json.Unmarshal(params, &p) != nil || p.FrameID != t.id {
			return
		}
		t.loading = loading
		t.surface.publish()
		if !loading {
			// The title, which target info keeps saying is the host, and the page as it finally
			// is, however the cast fared through the load.
			s.schedule(in, t, jobHistory|jobShot)
		}
	}
}

// Limits on what a page's words may cost a viewer.
const (
	maxDialogText = 4 << 10
	maxTitle      = 1 << 10
	maxLabel      = 200
	maxOptions    = 500
)

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return strings.ToValidUTF8(s[:n], "") + "…"
}

// onDialogOpening keeps what a page asks on that page. A page behind its popup is not on screen
// and cannot be answered, and held open it would stop the popup too when they share a process,
// so it is dismissed, as Chrome does for a tab in the background. A popup still being attached
// is about to show: its dialog waits.
func onDialogOpening(s *Store, in *instance, t *target, params json.RawMessage) {
	var p struct {
		URL           string `json:"url"`
		Message       string `json:"message"`
		Type          string `json:"type"`
		DefaultPrompt string `json:"defaultPrompt"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	sf := t.surface
	if sf.top() != t && slices.Contains(sf.stack, t) {
		go func() {
			if err := in.call(context.Background(), t.session, "Page.handleJavaScriptDialog", map[string]any{"accept": false}, nil); err != nil {
				s.log.Debug("dismiss a dialog behind a popup", "err", err)
			}
		}()
		return
	}
	// Chrome keeps dialogs from cross-origin frames off, so a frame's address has no better word
	// to say than the page's: a blank frame's says nothing, and the page's origin does.
	origin := originOf(p.URL)
	if origin == "" {
		origin = t.shownOrigin()
	}
	t.dialog = &Dialog{ID: sf.id(), Kind: p.Type, Message: clip(p.Message, maxDialogText), DefaultPrompt: clip(p.DefaultPrompt, maxDialogText), Origin: clipHost(origin), Site: clipHost(siteOf(origin))}
	sf.publish()
}

func onDialogClosed(_ *Store, _ *instance, t *target, _ json.RawMessage) {
	t.dialog = nil
	t.surface.publish()
}

// onSecurityState follows what Chrome says of the page: a failed certificate stays failed on a
// page the user went on to anyway, which the scheme alone would show as https.
func onSecurityState(_ *Store, _ *instance, t *target, params json.RawMessage) {
	var p struct {
		State struct {
			Security string `json:"securityState"`
		} `json:"visibleSecurityState"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	t.badCert = p.State.Security == "insecure-broken"
	t.surface.publish()
}

func onFileChooser(_ *Store, _ *instance, t *target, params json.RawMessage) {
	t.openChooser(t.session, t.shownOrigin(), params)
}

// openChooser is a file input of this page or of an iframe in it, whose session has to answer it.
// Needs Store.mu.
func (t *target) openChooser(session, origin string, params json.RawMessage) {
	var p struct {
		Mode string `json:"mode"`
		Node int64  `json:"backendNodeId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	sf := t.surface
	t.chooser = &FileChooser{ID: sf.id(), Multiple: p.Mode == "selectMultiple", Origin: clipHost(origin), Site: clipHost(siteOf(origin)), node: p.Node, session: session}
	sf.publish()
}

type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	OpenerID string `json:"openerId"`
}

func decodeInfo(params json.RawMessage) (targetInfo, bool) {
	var p struct {
		TargetInfo targetInfo `json:"targetInfo"`
	}
	return p.TargetInfo, json.Unmarshal(params, &p) == nil
}

// onTargetInfoChanged is nothing a surface reads, but a page sends one for every address it pushes,
// so it pays for them as for the rest.
func onTargetInfoChanged(s *Store, in *instance, params json.RawMessage) {
	if info, ok := decodeInfo(params); ok {
		if t := in.targets[info.TargetID]; t != nil {
			s.charge(in, t, len(params))
		}
	}
}

// onTargetCreated adopts what a surface's page opens, window.open and target=_blank alike: a
// popup keeps its opener, so sign-in popups that report back to it still work. It shows in
// place of its opener and closes back to it.
func onTargetCreated(s *Store, in *instance, params json.RawMessage) {
	info, ok := decodeInfo(params)
	if !ok || info.Type != "page" || info.OpenerID == "" {
		return
	}
	opener := in.targets[info.OpenerID]
	if opener == nil || in.targets[info.TargetID] != nil {
		return
	}
	t := &target{id: info.TargetID, surface: opener.surface, popup: true}
	in.targets[t.id] = t
	go s.showPopup(in, opener, t)
}

// showPopup moves the surface onto a popup.
func (s *Store) showPopup(in *instance, opener, t *target) {
	ctx := context.Background()
	if err := s.adopt(ctx, in, t); err != nil {
		// Half set up, it would run out of sight, unwatched, for as long as Chrome does.
		s.log.Debug("popup not adopted, so closed", "err", err)
		s.mu.Lock()
		in.untrack(t)
		s.mu.Unlock()
		_ = in.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.id}, nil)
		return
	}
	s.mu.Lock()
	sf := t.surface
	if sf.top() != opener {
		// The opener is not showing: nothing would ever bring this popup up.
		s.mu.Unlock()
		_ = in.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.id}, nil)
		return
	}
	sf.stack = append(sf.stack, t)
	t.unpainted = true
	sf.dropFrame()
	viewed := len(sf.viewers) > 0
	sf.publish()
	s.mu.Unlock()
	s.readAddress(ctx, in, t)
	if viewed {
		_ = in.call(ctx, opener.session, "Page.stopScreencast", nil, nil)
		if err := s.startCast(ctx, in, t); err != nil {
			s.log.Debug("popup screencast", "err", err)
		}
	}
}

// readAddress asks what a popup has committed, which may be nothing yet: the address a new target
// reports is where it is headed, and an opener can write its own page under that while it loads.
// An event that came meanwhile is newer than the answer, which then says nothing.
//
// It asks the page's own document, in the helper's world, where no script of the page's reaches,
// for its address and origin: Chrome caps an address at 2 MB. Page.getFrameTree would say
// the same with every frame's address in it, which a page can make past the pipe's limit, and
// the call then fails. A read that fails leaves the address empty, which a viewer shows as a page
// nobody can name, and Not secure (surface.security).
func (s *Store) readAddress(ctx context.Context, in *instance, t *target) {
	s.mu.Lock()
	seen := t.commits
	s.mu.Unlock()
	var here []string
	if _, err := in.helperValue(ctx, t.session, t.id, helperAddress, &here); err != nil || len(here) != 2 {
		s.log.Debug("popup address", "err", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.commits != seen {
		return
	}
	t.commit(here[0], chromeOrigin(here[1]))
	t.surface.publish()
	// A popup that committed and loaded before its session was set up sent no event for it: its
	// title and way back are read here or never.
	s.committed(in, t, jobHistory)
}

func onTargetDestroyed(s *Store, in *instance, params json.RawMessage) {
	var p struct {
		TargetID string `json:"targetId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	t := in.targets[p.TargetID]
	if t == nil {
		return
	}
	in.untrack(t)
	sf := t.surface
	wasTop := sf.top() == t
	for i, x := range sf.stack {
		if x == t {
			sf.stack = append(sf.stack[:i], sf.stack[i+1:]...)
			break
		}
	}
	if !wasTop {
		// The page on screen is the same, but whether it is a popup, and has a way back, may not be.
		sf.publish()
		return
	}
	if next := sf.top(); next != nil {
		next.unpainted = true
		sf.dropFrame()
	}
	sf.publish()
	if len(sf.viewers) == 0 {
		return
	}
	if next := sf.top(); next != nil {
		go func() {
			ctx := context.Background()
			_ = s.applySize(ctx, in, next)
			_ = s.startCast(ctx, in, next)
		}()
	} else {
		go s.bringUp(sf)
	}
}

// untrack forgets a target and its frames. Needs Store.mu.
func (in *instance) untrack(t *target) {
	if in.targets[t.id] == t {
		delete(in.targets, t.id)
	}
	if t.session != "" && in.sessions[t.session] == t {
		delete(in.sessions, t.session)
	}
	in.forgetFrames(t)
}

// painted is a frame of this page reaching its viewers: what they show is its own again. Needs
// Store.mu.
func (t *target) painted() {
	if t.unpainted {
		t.unpainted = false
		t.surface.publish()
	}
}

func onTargetCrashed(_ *Store, in *instance, params json.RawMessage) {
	var p struct {
		TargetID string `json:"targetId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	if t := in.targets[p.TargetID]; t != nil {
		t.surface.state.Notice = "This page crashed. Reload to try again."
		t.surface.publish()
	}
}
