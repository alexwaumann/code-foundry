package browser

import (
	"context"
	"encoding/json"
)

// A cross-site iframe runs in another process, and Page.setInterceptFileChooserDialog, the select
// helper and a download's session stop at that boundary: one set on the page reaches none of them,
// so a file input in such a frame would open the Mac's real panel. Target.setAutoAttach puts each
// one, nested ones too, on a session of its own, paused until the same set-up is done.

// maxFrames bounds the sessions of one page. A frame past it stays paused, blank and harmless, and
// only that page is the poorer for it.
const maxFrames = 32

// frameCost is what a frame going to another site takes from its page's allowance (pacing.go). It
// is a process, started as the navigation does and before any session is attached: a page sending
// frames to new sites in a loop made 26 GB of renderers in seconds, with no one process big and few
// events. So a page gets about 40 at once, and five a second after that.
const frameCost = 192 << 10

// frame is a cross-site iframe. Its fields need Store.mu.
type frame struct {
	id, session string
	owner       *target
	url, origin string
}

// shownOrigin is who the frame is, as for a target.
func (f *frame) shownOrigin() string {
	if f.origin != "" {
		return f.origin
	}
	return originOf(f.url)
}

func onFrameAttached(s *Store, in *instance, t *target, params json.RawMessage) {
	s.frameAttached(in, t, params)
}

func onNestedFrameAttached(s *Store, in *instance, f *frame, params json.RawMessage) {
	s.frameAttached(in, f.owner, params)
}

// frameAttached takes a new iframe of owner's page, wherever in it. It is paused, and only its
// set-up resumes it. Needs Store.mu.
func (s *Store) frameAttached(in *instance, owner *target, params json.RawMessage) {
	var p struct {
		Session string     `json:"sessionId"`
		Info    targetInfo `json:"targetInfo"`
	}
	if json.Unmarshal(params, &p) != nil || p.Info.Type != "iframe" || in.frames[p.Session] != nil {
		return
	}
	if owner.frames >= maxFrames {
		s.log.Debug("an iframe past the limit stays paused")
		return
	}
	owner.frames++
	f := &frame{id: p.Info.TargetID, session: p.Session, owner: owner}
	in.frames[p.Session] = f
	go s.adoptFrame(in, f)
}

// adoptFrame gives an iframe what every session gets, and only then lets it run: a frame whose
// set-up failed stays paused.
func (s *Store) adoptFrame(in *instance, f *frame) {
	ctx := context.Background()
	err := in.run(ctx, f.session, sessionSteps)
	if err == nil {
		err = in.call(ctx, f.session, "Runtime.runIfWaitingForDebugger", nil, nil)
	}
	if err != nil {
		s.log.Debug("iframe not adopted", "err", err)
	}
}

func onFrameStartedNavigating(s *Store, in *instance, t *target, params json.RawMessage) {
	s.frameHeadingOut(in, t, params)
}

func onNestedFrameStartedNavigating(s *Store, in *instance, f *frame, params json.RawMessage) {
	s.frameHeadingOut(in, f.owner, params)
}

// frameHeadingOut charges a page for a subframe leaving for another site. Needs Store.mu.
func (s *Store) frameHeadingOut(in *instance, owner *target, params json.RawMessage) {
	var p struct {
		FrameID string `json:"frameId"`
		URL     string `json:"url"`
	}
	if json.Unmarshal(params, &p) != nil || p.FrameID == owner.id {
		return
	}
	if site := siteOf(p.URL); site != "" && site != siteOf(owner.shownOrigin()) {
		s.charge(in, owner, frameCost)
	}
}

func onFrameDetached(s *Store, in *instance, _ *target, params json.RawMessage) {
	in.frameDetached(params)
}

func onNestedFrameDetached(s *Store, in *instance, _ *frame, params json.RawMessage) {
	in.frameDetached(params)
}

// frameDetached forgets an iframe that went. Needs Store.mu.
func (in *instance) frameDetached(params json.RawMessage) {
	var p struct {
		Session string `json:"sessionId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	if f := in.frames[p.Session]; f != nil {
		delete(in.frames, p.Session)
		f.owner.frames--
	}
}

// forgetFrames drops a page's iframes with the page. Needs Store.mu.
func (in *instance) forgetFrames(t *target) {
	for session, f := range in.frames {
		if f.owner == t {
			delete(in.frames, session)
		}
	}
	t.frames = 0
}

// onSubframeNavigated keeps who an iframe is. Frames inside it report here too, and are not it.
func onSubframeNavigated(_ *Store, _ *instance, f *frame, params json.RawMessage) {
	var p frameParams
	if json.Unmarshal(params, &p) != nil || p.Frame.ID != f.id {
		return
	}
	f.url, f.origin = p.Frame.URL, chromeOrigin(p.Frame.Origin)
}

func onSubframeChooser(_ *Store, _ *instance, f *frame, params json.RawMessage) {
	f.owner.openChooser(f.session, f.shownOrigin(), params)
}

// frameSessions are the sessions that can hold a page's frames. Needs no lock held.
func (s *Store) frameSessions(in *instance, t *target) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []string{t.session}
	for session, f := range in.frames {
		if f.owner == t {
			out = append(out, session)
		}
	}
	return out
}
