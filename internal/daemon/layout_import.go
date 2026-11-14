package daemon

import (
	"context"
	"log/slog"
	"maps"
	"slices"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// legacyImport is LayoutService.ImportLegacy's daemon side (api.LegacyImporter;
// docs/notes/shell-18-legacy-import.md): it gives the pure import (internal/layout,
// legacy.go) the threads and terminals the daemon has, commits it through the layout store
// (once in the database's life), then labels each shell the import made a thread's quick
// terminal. Labelling is metadata: no process is touched. Terminals do not survive a
// daemon restart, so a crash between the commit and the labels leaves no shell to label.
type legacyImport struct {
	log       *slog.Logger
	layout    layoutstore.Store
	terminals terminal.Store
	threads   func() *thread.Snapshot
	// projects and plugins say what a tab may still show: a diff of a project no longer
	// registered, or a surface no installed plugin offers, is dropped. Nil: not checked.
	projects func() *project.Snapshot
	plugins  func() *plugin.Snapshot
}

// knownProjects is every registered project's id.
func knownProjects(snap *project.Snapshot) map[string]bool {
	out := map[string]bool{}
	if snap != nil {
		for _, p := range snap.Projects {
			out[p.ID] = true
		}
	}
	return out
}

// knownSurfaces is every surface an installed plugin offers, as a tab kind. A disabled plugin's
// surfaces count: its tab says why it shows nothing, and enabling it brings it back.
func knownSurfaces(snap *plugin.Snapshot) map[string]bool {
	out := map[string]bool{}
	if snap != nil {
		for _, p := range snap.Plugins {
			for _, s := range p.Manifest.Surfaces {
				out[plugin.SurfaceKind(p.Name, s.ID)] = true
			}
		}
	}
	return out
}

// ImportLegacy implements api.LegacyImporter.
func (l legacyImport) ImportLegacy(ctx context.Context, panelJSON, bottomJSON, clientID string) (layoutstore.ImportCommit, error) {
	if l.layout.Snapshot().LegacyImported {
		return l.layout.ImportLegacy(ctx, core.LegacyInput{}, layoutstore.ApplyOptions{ClientID: clientID})
	}
	in := core.LegacyInput{Panel: []byte(panelJSON), Bottom: []byte(bottomJSON)}
	if snap := l.threads(); snap != nil {
		for _, t := range snap.Threads {
			if !t.Removing {
				in.Threads = append(in.Threads, core.LegacyThread{ID: t.ID, Archived: !t.ArchivedAt.IsZero()})
			}
		}
	}
	if l.projects != nil {
		in.Projects = knownProjects(l.projects())
	}
	if l.plugins != nil {
		in.Surfaces = knownSurfaces(l.plugins())
	}
	for _, t := range l.terminals.List(ctx) {
		in.Terminals = append(in.Terminals, core.LegacyTerminal{
			ID: t.ID, Labels: t.Labels, StartedAt: t.StartedAt, Exited: t.State == terminal.StateExited,
		})
	}
	c, err := l.layout.ImportLegacy(ctx, in, layoutstore.ApplyOptions{ClientID: clientID})
	if err != nil || !c.Imported {
		return c, err
	}
	for _, th := range slices.Sorted(maps.Keys(c.Result.Quick)) {
		id := c.Result.Quick[th]
		t, err := l.terminals.Get(ctx, id)
		if err == nil {
			labels := maps.Clone(t.Labels)
			maps.Copy(labels, termlabel.QuickShell(th, t.Labels[termlabel.Project], t.Labels[termlabel.Worktree]))
			_, err = l.terminals.SetLabels(ctx, id, labels)
		}
		if err != nil {
			l.log.Warn("layout import: could not make a shell its thread's quick terminal", "thread", th, "terminal", id, "err", err)
		}
	}
	l.log.Info("layout: imported the classic panels", "threads", len(c.Result.Threads), "quick", len(c.Result.Quick),
		"folded", len(c.Result.Folded), "removed", len(c.Result.Removed), "dropped", c.Result.Dropped)
	return c, nil
}
