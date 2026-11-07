package browser

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
)

// target is one page in Chrome: a surface's own, or a popup it opened. Its fields need
// Store.mu.
type target struct {
	id, session string
	surface     *surface
	url, title  string
	loading     bool
	canBack     bool
	canForward  bool
	casting     bool
	cast        sync.Mutex // held across a start or restart of the frames
}

// handlers are the events a surface follows, by method. A handler runs on the connection's
// reader with Store.mu held, so it never makes a call; what needs one runs in a goroutine.
// Filled by init: the handlers reach the launch, which reaches these tables.
var handlers map[string]func(s *Store, in *instance, t *target, params json.RawMessage)

// browserHandlers are the events of the browser itself, which arrive with no session.
var browserHandlers map[string]func(s *Store, in *instance, params json.RawMessage)

func init() {
	handlers = map[string]func(s *Store, in *instance, t *target, params json.RawMessage){
		"Page.frameNavigated":          onFrameNavigated,
		"Page.navigatedWithinDocument": onWithinDocument,
		"Page.frameStartedLoading":     onLoading(true),
		"Page.frameStoppedLoading":     onLoading(false),
		"Page.javascriptDialogOpening": onDialogOpening,
		"Page.javascriptDialogClosed":  onDialogClosed,
		"Page.fileChooserOpened":       onFileChooser,
		"Runtime.bindingCalled":        onBinding,
	}
	browserHandlers = map[string]func(s *Store, in *instance, params json.RawMessage){
		"Target.targetCreated":      onTargetCreated,
		"Target.targetInfoChanged":  onTargetChanged,
		"Target.targetDestroyed":    onTargetDestroyed,
		"Target.targetCrashed":      onTargetCrashed,
		"Browser.downloadWillBegin": onDownloadBegin,
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
	if h := handlers[method]; h != nil {
		if t := in.sessions[session]; t != nil {
			h(s, in, t, params)
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
	t.surface.frame = f
	for v := range t.surface.viewers {
		v.offerFrame(f)
	}
}

type frameParams struct {
	Frame struct {
		ID       string `json:"id"`
		ParentID string `json:"parentId"`
		URL      string `json:"url"`
		MimeType string `json:"mimeType"`
	} `json:"frame"`
}

func onFrameNavigated(s *Store, in *instance, t *target, params json.RawMessage) {
	var p frameParams
	if json.Unmarshal(params, &p) != nil || p.Frame.ParentID != "" {
		return
	}
	t.url = p.Frame.URL
	if !allowedPage(t.url) {
		// Chrome keeps pages off these on its own. If one ever got here it does not stay.
		t.surface.state.Notice = "That page is not allowed here."
		s.log.Warn("left a page a surface may not show")
		go func() {
			_ = in.call(context.Background(), t.session, "Page.navigate", map[string]any{"url": "about:blank"}, nil)
		}()
	}
	if p.Frame.MimeType == "application/pdf" {
		// Headless Chrome paints nothing for a PDF, so the last frame would stay up under
		// the new address.
		t.surface.state.Notice = "This surface cannot show PDFs."
	}
	t.surface.state.Select = nil
	t.surface.publish()
	go s.refreshHistory(in, t)
	if t.casting && t.surface.top() == t {
		// A navigation can move the page to another process, and a cast asked for during
		// the move is refused ("Not attached to an active page"). This one always lands.
		go func() {
			if err := s.startCast(context.Background(), in, t); err != nil {
				s.log.Debug("screencast after a navigation", "err", err)
			}
		}()
	}
}

func onWithinDocument(s *Store, in *instance, t *target, params json.RawMessage) {
	var p struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	t.url = p.URL
	t.surface.publish()
	go s.refreshHistory(in, t)
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
			go s.refreshHistory(in, t) // the title: target info keeps saying the host
			if t.casting && t.surface.top() == t {
				// The page as it finally is, however the cast fared through the load.
				go s.firstFrame(in, t, t.surface.w, t.surface.h)
			}
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

func onDialogOpening(_ *Store, _ *instance, t *target, params json.RawMessage) {
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
	sf.state.Dialog = &Dialog{ID: sf.id(), Kind: p.Type, Message: clip(p.Message, maxDialogText), DefaultPrompt: clip(p.DefaultPrompt, maxDialogText), Origin: originOf(p.URL)}
	sf.publish()
}

func onDialogClosed(_ *Store, _ *instance, t *target, _ json.RawMessage) {
	t.surface.state.Dialog = nil
	t.surface.publish()
}

func onFileChooser(_ *Store, _ *instance, t *target, params json.RawMessage) {
	var p struct {
		Mode string `json:"mode"`
		Node int64  `json:"backendNodeId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	sf := t.surface
	sf.state.FileChooser = &FileChooser{ID: sf.id(), Multiple: p.Mode == "selectMultiple", Origin: originOf(t.url), node: p.Node, tgt: t}
	sf.publish()
}

// onBinding reads the isolated world's messages. Only that world holds the binding, so a page's
// own script cannot call it, but what it reports is still the page's and is treated as such.
func onBinding(s *Store, _ *instance, t *target, params json.RawMessage) {
	var p struct {
		Name    string `json:"name"`
		Payload string `json:"payload"`
		Context int64  `json:"executionContextId"`
	}
	if json.Unmarshal(params, &p) != nil || p.Name != helperBinding {
		return
	}
	var m struct {
		Type     string  `json:"t"`
		X        float64 `json:"x"`
		Y        float64 `json:"y"`
		W        float64 `json:"w"`
		Selected int     `json:"selected"`
		Options  []struct {
			Label    string `json:"label"`
			Disabled bool   `json:"disabled"`
		} `json:"options"`
	}
	if json.Unmarshal([]byte(p.Payload), &m) != nil || m.Type != "select" {
		return
	}
	sf := t.surface
	sel := &Select{ID: sf.id(), Selected: m.Selected, X: m.X, Y: m.Y, W: m.W, context: p.Context, tgt: t}
	for i, o := range m.Options {
		if i == maxOptions {
			break
		}
		sel.Options = append(sel.Options, SelectOption{Label: clip(o.Label, maxLabel), Disabled: o.Disabled})
	}
	sf.state.Select = sel
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
	t := &target{id: info.TargetID, surface: opener.surface, url: info.URL}
	in.targets[t.id] = t
	go s.showPopup(in, opener, t)
}

// showPopup moves the surface onto a popup.
func (s *Store) showPopup(in *instance, opener, t *target) {
	ctx := context.Background()
	if err := s.adopt(ctx, in, t); err != nil {
		s.log.Debug("popup not adopted", "err", err)
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
	viewed := len(sf.viewers) > 0
	sf.publish()
	s.mu.Unlock()
	if viewed {
		_ = in.call(ctx, opener.session, "Page.stopScreencast", nil, nil)
		if err := s.startCast(ctx, in, t); err != nil {
			s.log.Debug("popup screencast", "err", err)
		}
	}
}

func onTargetChanged(_ *Store, in *instance, params json.RawMessage) {
	info, ok := decodeInfo(params)
	if !ok {
		return
	}
	if t := in.targets[info.TargetID]; t != nil {
		if info.URL != "" {
			t.url = info.URL
		}
		t.surface.publish()
	}
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
	delete(in.targets, p.TargetID)
	delete(in.sessions, t.session)
	sf := t.surface
	wasTop := sf.top() == t
	for i, x := range sf.stack {
		if x == t {
			sf.stack = append(sf.stack[:i], sf.stack[i+1:]...)
			break
		}
	}
	if !wasTop {
		return
	}
	sf.state.Dialog, sf.state.FileChooser, sf.state.Select = nil, nil, nil
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

func onDownloadBegin(_ *Store, in *instance, params json.RawMessage) {
	var p struct {
		FrameID string `json:"frameId"`
		GUID    string `json:"guid"`
		Name    string `json:"suggestedFilename"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	t := in.targets[p.FrameID]
	if t == nil {
		return // a subframe's: the surface says nothing, and it still lands in the folder
	}
	sf := t.surface
	sf.state.Downloads = append(sf.state.Downloads, Download{ID: p.GUID, Name: clip(p.Name, maxLabel), State: "inProgress"})
	if n := len(sf.state.Downloads); n > maxDownloadList {
		sf.state.Downloads = sf.state.Downloads[n-maxDownloadList:]
	}
	sf.publish()
}

func onDownloadProgress(_ *Store, in *instance, params json.RawMessage) {
	var p struct {
		GUID     string `json:"guid"`
		State    string `json:"state"`
		FilePath string `json:"filePath"`
	}
	if json.Unmarshal(params, &p) != nil || p.State == "inProgress" {
		return
	}
	for _, t := range in.targets {
		ds := t.surface.state.Downloads
		for i := range ds {
			if ds[i].ID == p.GUID {
				ds[i].State, ds[i].Path = p.State, p.FilePath
				t.surface.publish()
				return
			}
		}
	}
}
