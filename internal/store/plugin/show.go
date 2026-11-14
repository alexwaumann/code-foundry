package plugin

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sync"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Availability in the command registry: a manifest command's when clause is its When,
// and every surface gets plugin.<name>.show.<surface>, whose availability is the
// surface's. CommandService.List carries both to the GUI (and the CLI), so the GUI
// learns which plugin tabs a selection offers from the command list it already syncs.

// TabOpener opens a tab in the window shell's layout: by the placement rules (focused where it
// is when its identity is open), taking the user's focus only with focus. The daemon adapts
// the layout store.
type TabOpener interface {
	OpenTab(ctx context.Context, tb *layout.Tab, focus bool) (layout.Result, error)
}

// ShowResult is a show command's JSON when it opened a tab.
type ShowResult struct {
	Thread   string `json:"thread_id"`
	Space    string `json:"space_id"`
	Pane     string `json:"pane_id"`
	Tab      string `json:"tab_id"`
	Existing bool   `json:"existing,omitempty"`
	Focused  bool   `json:"focused,omitempty"`
}

// threadScoped reports whether a surface of scope shows a thread's: its tab is linked to that
// thread (a pull request surface is the thread's pull request's).
func threadScoped(scope string) bool {
	return scope == pluginsdk.ScopeThread || scope == pluginsdk.ScopePR
}

// ShowCommand is the name of the command that shows a surface.
func ShowCommand(plugin, surface string) string { return Prefix(plugin) + "show." + surface }

// SurfaceKind is a surface's GUI kind: plugin.<plugin>.<surface>. Its ShowView name is
// "panel." + the kind, with the context as a query (ShowViewName).
func SurfaceKind(plugin, surface string) string { return "plugin." + plugin + "." + surface }

// ShowViewName is the UiIntent.ShowView name a show command emits: panel.<kind>, plus
// "?thread=<id>", "?project=<id>" or "?worktree=<path>" when the surface's scope reads
// one (the GUI shows the tab in that selection's panel).
func ShowViewName(plugin, surface string, scope string, uctx command.Context) string {
	name := "panel." + SurfaceKind(plugin, surface)
	q := url.Values{}
	switch scope {
	case pluginsdk.ScopeGlobal:
	case pluginsdk.ScopeProject:
		if uctx.ActiveProjectID != "" {
			q.Set("project", uctx.ActiveProjectID)
		}
	case pluginsdk.ScopeWorktree:
		if uctx.ActiveWorktreePath != "" {
			q.Set("worktree", uctx.ActiveWorktreePath)
		}
	default:
		if uctx.ActiveThreadID != "" {
			q.Set("thread", uctx.ActiveThreadID)
		}
	}
	if len(q) > 0 {
		name += "?" + q.Encode()
	}
	return name
}

// predicates caches compiled when clauses by source.
type predicates struct {
	mu sync.Mutex
	m  map[string]predResult
}

type predResult struct {
	p   *Predicate
	err error
}

// predicate compiles a when clause (cached); "" is nil, always true.
func (m *Manager) predicate(src string) (*Predicate, error) {
	if src == "" {
		return nil, nil
	}
	m.preds.mu.Lock()
	defer m.preds.mu.Unlock()
	if r, ok := m.preds.m[src]; ok {
		return r.p, r.err
	}
	if m.preds.m == nil {
		m.preds.m = map[string]predResult{}
	}
	p, err := CompilePredicate(src)
	m.preds.m[src] = predResult{p, err}
	return p, err
}

// predicateIssues are a manifest's when clauses that do not compile.
func (m *Manager) predicateIssues(mf pluginsdk.Manifest) []string {
	var out []string
	for i, c := range mf.Commands {
		if _, err := m.predicate(c.When); err != nil {
			out = append(out, fmt.Sprintf("commands[%d].when: %v (the command is never available)", i, err))
		}
	}
	for i, s := range mf.Surfaces {
		if _, err := m.predicate(s.When); err != nil {
			out = append(out, fmt.Sprintf("surfaces[%d].when: %v (the surface is never available)", i, err))
		}
	}
	return out
}

// commandWhen is a manifest command's When and WhyUnavailable; nil, nil without a when
// clause.
func (m *Manager) commandWhen(src string) (func(command.Context) bool, func(command.Context) string) {
	if src == "" {
		return nil, nil
	}
	p, err := m.predicate(src)
	if err != nil {
		why := "its when clause does not compile: " + err.Error()
		return func(command.Context) bool { return false }, func(command.Context) string { return why }
	}
	return func(uctx command.Context) bool { return m.evalPredicate(p, uctx).ok },
		func(uctx command.Context) string { return m.evalPredicate(p, uctx).reason }
}

// showCommands are a manifest's plugin.<name>.show.<surface> commands.
func (m *Manager) showCommands(name string, mf pluginsdk.Manifest) []command.Command {
	out := make([]command.Command, 0, len(mf.Surfaces))
	for _, s := range mf.Surfaces {
		spec := s
		if spec.Scope == "" {
			spec.Scope = pluginsdk.ScopeThread
		}
		var args []command.ArgSpec
		switch spec.Scope {
		case pluginsdk.ScopeThread, pluginsdk.ScopePR:
			args = []command.ArgSpec{{Name: "thread", Type: command.String, Context: command.ContextThread, ID: command.ThreadID,
				Description: "Thread id; the tab opens beside it without taking the user's focus" + command.IDHelp},
				{Name: "focus", Type: command.Bool, Description: "Also take the user's focus to the tab; only when the user asked to be taken there"}}
		case pluginsdk.ScopeProject:
			args = []command.ArgSpec{{Name: "project", Type: command.String, Context: command.ContextProject, Description: "Project id"}}
		case pluginsdk.ScopeWorktree:
			args = []command.ArgSpec{{Name: "worktree", Type: command.Path, Context: command.ContextWorktree, Description: "Worktree path"}}
		}
		// A thread's surface is a tab linked to the thread, placed by the layout's rules
		// (openSurfaceTab); the others go to the windows as before.
		as := "as a tab"
		if threadScoped(spec.Scope) {
			as = "as a tab linked to the thread, beside it by the app's placement rules (an open one is found, not doubled)"
		}
		out = append(out, command.Command{
			Name:  ShowCommand(name, spec.ID),
			Title: "Show " + spec.Title,
			Description: fmt.Sprintf("Open %s's %s surface %s (%s scope). Available where the surface is: "+
				"`code-foundry plugin surface %s %s` prints its view.", mf.DisplayNameOr(), spec.Title, as, spec.Scope, name, spec.ID),
			Category:       mf.DisplayNameOr(),
			Args:           args,
			When:           func(uctx command.Context) bool { return m.surfaceAvailability(spec, uctx).ok },
			WhyUnavailable: func(uctx command.Context) string { return m.surfaceAvailability(spec, uctx).reason },
			Run: func(ctx context.Context, uctx command.Context, a command.Args) (command.Result, error) {
				if threadScoped(spec.Scope) && m.opts.Tabs != nil {
					return m.openSurfaceTab(ctx, uctx, a, name, spec)
				}
				if m.opts.Emitter == nil {
					return command.Result{}, errors.New("no GUI to show it in")
				}
				view := ShowViewName(name, spec.ID, spec.Scope, uctx)
				return command.EmitTo(m.opts.Emitter, &v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: view}}}).CLIResult(uctx), nil
			},
		})
	}
	return out
}

// openSurfaceTab is a thread or pull request surface's show command with a layout: a tab of
// the surface linked to the thread, placed by the rules beside it like the view.open verbs'
// (docs/notes/shell-24a-import-moves.md, item 5). Its identity is one per surface and thread
// (internal/layout identity.go). The user's own call focuses it; a thread's, a page's or a
// plugin's never does without --focus.
func (m *Manager) openSurfaceTab(ctx context.Context, uctx command.Context, a command.Args, name string, spec pluginsdk.SurfaceSpec) (command.Result, error) {
	thread := uctx.ActiveThreadID
	focus := uctx.FromUser()
	if a.Given("focus") {
		focus = a.Bool("focus")
	}
	tb := &layout.Tab{Kind: SurfaceKind(name, spec.ID), Thread: thread, Title: spec.Title}
	r, err := m.opts.Tabs.OpenTab(ctx, tb, focus)
	if err != nil {
		return command.Result{}, fmt.Errorf("could not open its tab: %w", err)
	}
	out := ShowResult{Thread: thread, Space: r.Space, Pane: r.Pane, Tab: r.Tab, Existing: r.Existing, Focused: focus}
	verb := "opened"
	if r.Existing {
		verb = "found"
	}
	msg := fmt.Sprintf("%s %s for thread %s as tab %s in pane %s", verb, spec.Title, thread, r.Tab, r.Pane)
	if !focus {
		msg += " (the user's focus did not move)"
	}
	return command.Result{Message: msg, JSON: out}, nil
}
