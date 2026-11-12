package api

import (
	"context"
	"slices"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ThemeStore is the user's themes (*usertheme.Store) as the EventService theme source
// reads them. Writes are the theme.* commands'.
type ThemeStore interface {
	// Snapshot is the themes directory as last read (Watch keeps it current).
	Snapshot() *usertheme.Snapshot
	// Dir is the themes directory; Path a theme's file in it.
	Dir() string
	Path(id string) string
}

var _ ThemeStore = (*usertheme.Store)(nil)

// themeSource is EventService's theme source: every theme, on connect and per change.
type themeSource struct {
	store ThemeStore
	bus   *bus.Bus
}

func (themeSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_THEME }

func (s themeSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, func(ev usertheme.Changed) *v1.Event {
		if ev.Snapshot == nil {
			return nil
		}
		return &v1.Event{Event: &v1.Event_Theme{Theme: &v1.ThemeEvent{Snapshot: themeSnapshotToProto(s.store, ev.Snapshot)}}}
	})}
}

func (s themeSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{{Event: &v1.Event_Theme{Theme: &v1.ThemeEvent{Snapshot: themeSnapshotToProto(s.store, s.store.Snapshot())}}}}
}

func themeSnapshotToProto(store ThemeStore, snap *usertheme.Snapshot) *v1.ThemeSnapshot {
	out := &v1.ThemeSnapshot{Dir: store.Dir(), Version: snap.Version}
	for _, t := range theme.Themes() {
		out.Curated = append(out.Curated, &v1.CuratedTheme{Id: t.ID, Name: t.Name, Scheme: t.Scheme, Pair: t.Pair})
	}
	for _, f := range snap.Themes {
		u := theme.ToProto(f, store.Path(f.ID))
		u.History = slices.Clone(snap.History[f.ID])
		out.User = append(out.User, u)
	}
	for _, is := range snap.Issues {
		out.Issues = append(out.Issues, &v1.ThemeFileIssue{File: is.File, Message: is.Message})
	}
	return out
}
