package main

import (
	"slices"
	"testing"
)

// fakeMenuBarHost records what menuBar asks for.
type fakeMenuBarHost struct{ calls []string }

func (h *fakeMenuBarHost) showItem() { h.calls = append(h.calls, "item.show") }
func (h *fakeMenuBarHost) hideItem() { h.calls = append(h.calls, "item.hide") }
func (h *fakeMenuBarHost) conceal()  { h.calls = append(h.calls, "conceal") }
func (h *fakeMenuBarHost) reveal()   { h.calls = append(h.calls, "reveal") }

func TestMenuBar(t *testing.T) {
	type step struct {
		do       func(*menuBar) // nil: the window closes
		kept     bool           // what windowClosing reports
		wantHost []string
	}
	on := func(m *menuBar) { m.setAnywhere(true) }
	off := func(m *menuBar) { m.setAnywhere(false) }
	open := func(m *menuBar) { m.open() }
	quit := func(m *menuBar) { m.shuttingDown() }
	tests := []struct {
		name  string
		steps []step
	}{
		{"off: a close goes through and nothing is touched", []step{
			{do: off},
			{},
		}},
		{"on: the item shows once, however many snapshots", []step{
			{do: on, wantHost: []string{"item.show"}},
			{do: on},
		}},
		{"on: closing hides, and a second close does not hide again", []step{
			{do: on, wantHost: []string{"item.show"}},
			{kept: true, wantHost: []string{"conceal"}},
			{kept: true},
		}},
		{"open brings the window back, and a later close hides it again", []step{
			{do: on, wantHost: []string{"item.show"}},
			{kept: true, wantHost: []string{"conceal"}},
			{do: open, wantHost: []string{"reveal"}},
			{kept: true, wantHost: []string{"conceal"}},
		}},
		{"open with the window showing brings it to the front", []step{
			{do: on, wantHost: []string{"item.show"}},
			{do: open, wantHost: []string{"reveal"}},
		}},
		{"turned off with the window showing: the item goes, the close goes through", []step{
			{do: on, wantHost: []string{"item.show"}},
			{do: off, wantHost: []string{"item.hide"}},
			{},
		}},
		{"turned off with the window hidden: it comes back", []step{
			{do: on, wantHost: []string{"item.show"}},
			{kept: true, wantHost: []string{"conceal"}},
			{do: off, wantHost: []string{"item.hide", "reveal"}},
			{},
		}},
		{"turned on again: the item returns", []step{
			{do: on, wantHost: []string{"item.show"}},
			{do: off, wantHost: []string{"item.hide"}},
			{do: on, wantHost: []string{"item.show"}},
		}},
		{"quitting: the window's close goes through while on and showing", []step{
			{do: on, wantHost: []string{"item.show"}},
			{do: quit},
			{},
		}},
		{"quitting: and while hidden", []step{
			{do: on, wantHost: []string{"item.show"}},
			{kept: true, wantHost: []string{"conceal"}},
			{do: quit},
			{},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := &fakeMenuBarHost{}
			m := &menuBar{host: host}
			for i, st := range tt.steps {
				host.calls = nil
				if st.do != nil {
					st.do(m)
				} else if kept := m.windowClosing(); kept != st.kept {
					t.Fatalf("step %d: windowClosing = %v, want %v", i, kept, st.kept)
				}
				if !slices.Equal(host.calls, st.wantHost) {
					t.Fatalf("step %d: host calls %v, want %v", i, host.calls, st.wantHost)
				}
			}
		})
	}
}

func TestDockBadgeRedraw(t *testing.T) {
	var shown []string
	b := &dockBadge{apply: func(l string) { shown = append(shown, l) }}
	b.set("3")
	b.redraw() // before launch: held for didLaunch
	b.didLaunch()
	b.redraw()
	if want := []string{"3", "3"}; !slices.Equal(shown, want) {
		t.Errorf("shown %v, want %v", shown, want)
	}
}
