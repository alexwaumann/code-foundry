package layout

import "sync"

// maxViewports bounds how many windows' reports Viewports keeps; the oldest goes first.
const maxViewports = 16

// Viewports keeps the pane area each window reported (SetViewport) and answers the one the
// daemon lays out in: the newest report from a window that is visible now, else the newest
// report from any window (kept when the window goes), else DefaultViewport
// (docs/notes/shell-4-commands.md; docs/notes/shell-6-lifecycle.md). Which windows are
// visible is the daemon's presence, handed in with SetVisible. The zero value is ready.
type Viewports struct {
	mu      sync.Mutex
	seq     uint64
	by      map[string]reported
	visible func(clientID string) bool
}

type reported struct {
	vp  Viewport
	seq uint64
}

// SetVisible sets how to tell whether a window (by client id) is visible now. Nil: none is,
// so the newest report wins.
func (v *Viewports) SetVisible(f func(clientID string) bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.visible = f
}

// Set records the pane area clientID reported. It refuses one CheckViewport refuses.
func (v *Viewports) Set(clientID string, vp Viewport) error {
	if err := CheckViewport(vp); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.by == nil {
		v.by = map[string]reported{}
	}
	v.seq++
	v.by[clientID] = reported{vp: vp, seq: v.seq}
	if len(v.by) > maxViewports {
		oldest := ""
		for id, r := range v.by {
			if oldest == "" || r.seq < v.by[oldest].seq {
				oldest = id
			}
		}
		delete(v.by, oldest)
	}
	return nil
}

// Current is the pane area to lay out in.
func (v *Viewports) Current() Viewport {
	v.mu.Lock()
	visible := v.visible
	by := make(map[string]reported, len(v.by))
	for id, r := range v.by {
		by[id] = r
	}
	v.mu.Unlock()
	var best, seen reported
	for id, r := range by {
		if r.seq > seen.seq {
			seen = r
		}
		// visible is called without v.mu: it reads the presence registry, which has its own.
		if id != "" && visible != nil && r.seq > best.seq && visible(id) {
			best = r
		}
	}
	switch {
	case best.seq > 0:
		return best.vp
	case seen.seq > 0:
		return seen.vp
	}
	return DefaultViewport
}
