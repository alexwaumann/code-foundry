package browser

import (
	"context"
	"encoding/json"
	"time"
)

// The daemon's own script in each page and iframe, in an isolated world: the page's scripts share
// the DOM with it but not its variables. It exists because Chrome's <select> popup is a native
// menu that never reaches a screencast, and on a Mac the arrow keys open that menu too, so a select
// would be dead. It reads a select's options and sets the one the user picks; agents have no way to
// reach it.
//
// It cannot call the daemon: a binding needs Runtime.enable, and that hands every page's console to
// the pipe (surface.go). So it only keeps what it saw, and the daemon asks after each press that
// could have opened a select. Page.createIsolatedWorld with this world's name finds the same world,
// script and all (measured on Chrome 157), and neither it nor Runtime.evaluate needs Runtime.enable.
const (
	helperWorld = "code-foundry-surface"
	helperPick  = "__cfPick"
	helperTake  = "__cfTake()"
	helperLink  = "__cfOnLink()"
	// helperOrigin is a page's real origin. In this world a page's script cannot redefine it.
	helperOrigin = "self.origin"
	// helperFrame is the helper's answer when focus went into a frame: the select is there, if any.
	helperFrame = "frame"
)

// selectKeys are the keys that open a focused select.
var selectKeys = []string{" ", "ArrowUp", "ArrowDown"}

const helperSource = `(() => {
  if (globalThis.__cfOpen) return;
  let open = null;
  let waiting = "";
  const report = (s) => {
    open = s;
    const r = s.getBoundingClientRect();
    const options = [...s.options].slice(0, 500).map((o) => ({
      label: o.label || o.text,
      disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
    }));
    waiting = JSON.stringify({ t: "select", options, selected: s.selectedIndex, x: r.left, y: r.bottom, w: r.width });
  };
  const closed = (e) => {
    const t = e.target;
    const s = t instanceof Element ? t.closest("select") : null;
    return s && !s.multiple && s.size <= 1 && !s.disabled ? s : null;
  };
  globalThis.__cfOpen = report;
  addEventListener("mousedown", (e) => {
    const s = closed(e);
    if (!s || !e.isTrusted || e.button !== 0) return;
    e.preventDefault();
    s.focus();
    report(s);
  }, true);
  addEventListener("keydown", (e) => {
    const s = closed(e);
    if (!s || !e.isTrusted || ![" ", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    report(s);
  }, true);
  // On a Mac a colour input opens the system's panel, a real window on the desktop.
  addEventListener("click", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "color") e.preventDefault();
  }, true);
  globalThis.__cfTake = () => {
    const w = waiting;
    waiting = "";
    if (w) return w;
    const a = document.activeElement;
    return a instanceof HTMLIFrameElement || a instanceof HTMLFrameElement ? "frame" : "";
  };
  globalThis.__cfOnLink = () => {
    let a = document.activeElement;
    while (a && a.contentDocument) a = a.contentDocument.activeElement;
    return !!(a && a.closest("a[href], area[href]"));
  };
  globalThis.__cfPick = (i) => {
    const s = open;
    open = null;
    if (!s || i < 0 || i >= s.options.length || s.selectedIndex === i) return;
    s.selectedIndex = i;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  };
})();`

// linkWait bounds asking a page what has focus, which holds up the Enter it is for. A page too
// busy to say gets no gesture.
const linkWait = 500 * time.Millisecond

// maxFrameReads bounds how many frames one press asks. A page with more frames than this and a
// select in the last of them has that select stay shut.
const maxFrameReads = 32

// helperValue evaluates expression in the helper's world of a frame. A frame the helper has not
// reached answers nothing.
func (in *instance) helperValue(ctx context.Context, session, frameID, expression string, out any) (context int64, err error) {
	var world struct {
		Context int64 `json:"executionContextId"`
	}
	if err := in.call(ctx, session, "Page.createIsolatedWorld", map[string]any{"frameId": frameID, "worldName": helperWorld}, &world); err != nil {
		return 0, err
	}
	var res struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	err = in.call(ctx, session, "Runtime.evaluate", map[string]any{"contextId": world.Context, "expression": expression, "returnByValue": true}, &res)
	if err != nil || res.Result.Value == nil {
		return world.Context, err
	}
	return world.Context, json.Unmarshal(res.Result.Value, out)
}

// onLink reports the keyboard is on a link, before an Enter goes to the page. It looks through
// same-origin frames; focus inside a cross-site iframe is not known to be on one.
func (s *Store) onLink(ctx context.Context, in *instance, t *target) bool {
	ctx, cancel := context.WithTimeout(ctx, linkWait)
	defer cancel()
	var yes bool
	if _, err := in.helperValue(ctx, t.session, t.id, helperLink, &yes); err != nil {
		s.log.Debug("what has focus", "err", err)
		return false
	}
	return yes
}

// readOrigin asks a page with no origin yet who it is. Chrome's securityOrigin says "://" for a
// blank page that inherited a real origin (measured on Chrome 157), which is the case that matters:
// an about:blank another page can write into. The page's own origin says, and until it has, the
// surface says it cannot tell.
func (s *Store) readOrigin(ctx context.Context, in *instance, t *target) {
	s.mu.Lock()
	seen := t.commits
	s.mu.Unlock()
	var origin string
	if _, err := in.helperValue(ctx, t.session, t.id, helperOrigin, &origin); err != nil {
		s.log.Debug("read an origin", "err", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.commits == seen && t.origin == "" {
		t.origin = chromeOrigin(origin)
		t.surface.publish()
	}
}

// afterPress asks, off the caller, whether that press opened a select. mouse is nil for a key.
func (s *Store) afterPress(in *instance, t *target, mouse *MouseEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if mouse != nil {
		t.pressX, t.pressY = mouse.X, mouse.Y
	}
	s.schedule(in, t, jobSelect)
}

// readSelect takes what the helper kept: from the page, or from the frame focus went into.
func (s *Store) readSelect(ctx context.Context, in *instance, t *target) {
	s.mu.Lock()
	seen := t.commits
	s.mu.Unlock()
	var found string
	world, err := in.helperValue(ctx, t.session, t.id, helperTake, &found)
	if err != nil {
		s.log.Debug("read a select", "err", err)
		return
	}
	session, nested := t.session, false
	if found == helperFrame {
		found, session, world = s.readFrames(ctx, in, t)
		nested = true
	}
	if found != "" {
		s.openSelect(t, seen, session, world, nested, found)
	}
}

// readFrames asks the frames of a page, and those of its cross-site iframes, in turn.
func (s *Store) readFrames(ctx context.Context, in *instance, t *target) (found, session string, world int64) {
	left := maxFrameReads
	for _, session := range s.frameSessions(in, t) {
		var tree struct {
			FrameTree frameTree `json:"frameTree"`
		}
		if err := in.call(ctx, session, "Page.getFrameTree", nil, &tree); err != nil {
			continue
		}
		for _, id := range tree.FrameTree.ids() {
			if left == 0 {
				return "", "", 0
			}
			left--
			var v string
			world, err := in.helperValue(ctx, session, id, helperTake, &v)
			if err == nil && v != "" && v != helperFrame {
				return v, session, world
			}
		}
	}
	return "", "", 0
}

// frameTree is Page.getFrameTree's reply.
type frameTree struct {
	Frame struct {
		ID string `json:"id"`
	} `json:"frame"`
	Children []frameTree `json:"childFrames"`
}

func (f frameTree) ids() []string {
	out := []string{f.Frame.ID}
	for _, c := range f.Children {
		out = append(out, c.ids()...)
	}
	return out
}

// openSelect shows what the helper reported, which is the page's and treated as such. A select in
// a frame says where it sits in that frame, so the list opens where the user pressed.
func (s *Store) openSelect(t *target, seen int, session string, world int64, nested bool, report string) {
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
	if json.Unmarshal([]byte(report), &m) != nil || m.Type != "select" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.commits != seen {
		return
	}
	sf := t.surface
	sel := &Select{ID: sf.id(), Selected: m.Selected, X: m.X, Y: m.Y, W: m.W, context: world, session: session}
	if nested {
		sel.X, sel.Y = t.pressX, t.pressY
	}
	for i, o := range m.Options {
		if i == maxOptions {
			break
		}
		sel.Options = append(sel.Options, SelectOption{Label: clip(o.Label, maxLabel), Disabled: o.Disabled})
	}
	t.sel = sel
	sf.publish()
}
