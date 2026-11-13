package layout

// The ops that lay panes out to decide something (placement, restoring, remembering where a
// closed tab sat) take the pane area as W and H. Callers that serve a window or the CLI give
// every such op the area the store keeps (the last a window reported, plan section 2.4) with
// WithArea, so a CLI call places tabs as a key press in the window would.

// measured is an op that lays panes out in a W x H pane area.
type measured interface {
	setArea(w, h float64)
}

// WithArea gives op the pane area w x h when it lays panes out and names no area of its own.
// Other ops are left alone.
func WithArea(op Op, w, h float64) {
	if m, ok := op.(measured); ok {
		m.setArea(w, h)
	}
}

// Measures reports whether op lays panes out in a pane area (WithArea sets one).
func Measures(op Op) bool {
	_, ok := op.(measured)
	return ok
}

// area is (w, h) unless (cw, ch) already names one.
func area(cw, ch *float64, w, h float64) {
	if *cw > 0 && *ch > 0 {
		return
	}
	*cw, *ch = w, h
}

func (o *OpenSurface) setArea(w, h float64)       { area(&o.W, &o.H, w, h) }
func (o *OpenThread) setArea(w, h float64)        { area(&o.W, &o.H, w, h) }
func (o *CloseThread) setArea(w, h float64)       { area(&o.W, &o.H, w, h) }
func (o *MoveThreadToSpace) setArea(w, h float64) { area(&o.W, &o.H, w, h) }
func (o *SnoozeThread) setArea(w, h float64)      { area(&o.W, &o.H, w, h) }
func (o *ClosePane) setArea(w, h float64)         { area(&o.W, &o.H, w, h) }
func (o *MoveTab) setArea(w, h float64)           { area(&o.W, &o.H, w, h) }
func (o *MovePane) setArea(w, h float64)          { area(&o.W, &o.H, w, h) }
func (o *RemoveSpace) setArea(w, h float64)       { area(&o.W, &o.H, w, h) }
