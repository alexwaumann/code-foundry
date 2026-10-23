package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// ThemeStore is the user's themes (*usertheme.Store) as ThemeService and the EventService
// theme source read them. Writes are the theme.* commands', not this service's.
type ThemeStore interface {
	// Snapshot is the themes directory as last read (Watch keeps it current).
	Snapshot() *usertheme.Snapshot
	// Dir is the themes directory; Path a theme's file in it.
	Dir() string
	Path(id string) string
}

var _ ThemeStore = (*usertheme.Store)(nil)

// Theme implements codefoundryv1connect.ThemeServiceHandler over the user theme store
// and the curated catalog (docs/notes/user-themes.md).
type Theme struct {
	store ThemeStore
	bus   *bus.Bus
}

var _ codefoundryv1connect.ThemeServiceHandler = (*Theme)(nil)

// NewTheme returns a ThemeService handler. b must be the bus the store publishes
// usertheme.Changed on.
func NewTheme(store ThemeStore, b *bus.Bus) *Theme { return &Theme{store: store, bus: b} }

// Route mounts the service.
func (h *Theme) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewThemeServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns the themes as last read.
func (h *Theme) List(context.Context, *connect.Request[v1.ListThemesRequest]) (*connect.Response[v1.ListThemesResponse], error) {
	return connect.NewResponse(&v1.ListThemesResponse{Themes: themeSnapshotToProto(h.store, h.store.Snapshot())}), nil
}

// Watch sends the themes now, then all of them again per change.
func (h *Theme) Watch(ctx context.Context, _ *connect.Request[v1.WatchThemesRequest], stream *connect.ServerStream[v1.ThemeEvent]) error {
	sub := bus.Subscribe[usertheme.Changed](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(&v1.ThemeEvent{Snapshot: themeSnapshotToProto(h.store, h.store.Snapshot())}); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			snap := ev.Snapshot
			if d := sub.Dropped(); d != dropped {
				dropped = d
				snap = h.store.Snapshot()
			}
			if err := stream.Send(&v1.ThemeEvent{Snapshot: themeSnapshotToProto(h.store, snap)}); err != nil {
				return err
			}
		}
	}
}

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
		b := f.Base
		out.User = append(out.User, &v1.UserTheme{
			Id: f.ID, Name: f.Name, Scheme: f.Scheme, Pair: f.Pair, From: f.From, CreatedBy: f.CreatedBy, Source: f.Source,
			Base: &v1.ThemeBase{
				Canvas: b.Canvas, Surface: b.Surface, Text: b.Text, Accent: b.Accent,
				Success: b.Success, Warning: b.Warning, Error: b.Error, Info: b.Info, Highlight: b.Highlight, Link: b.Link,
				Terminal: &v1.ThemeTerminal{
					Foreground: b.Terminal.Foreground, Cursor: b.Terminal.Cursor, CursorText: b.Terminal.CursorText,
					Selection: b.Terminal.Selection, Ansi: b.Terminal.ANSI,
				},
			},
			Overrides: f.Overrides,
			Path:      store.Path(f.ID),
		})
	}
	for _, is := range snap.Issues {
		out.Issues = append(out.Issues, &v1.ThemeFileIssue{File: is.File, Message: is.Message})
	}
	return out
}
