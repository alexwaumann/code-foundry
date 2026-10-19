package daemon

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The plugin store's own threads and terminals (docs/notes/plugins-6-thread-terminal.md):
// pluginThreads adapts the thread store to plugin.OwnedThreads (a thread owned by
// "plugin:<name>", the user's default model and effort), pluginTerminals the terminal
// store to plugin.OwnedTerminals (labelled termlabel.PluginTerminal). Neither store
// imports the other.

type pluginThreads struct {
	threads  *thread.Manager
	settings *settings.Store
}

var _ plugin.OwnedThreads = pluginThreads{}

// ownedErrors map the thread and terminal stores' errors to the plugin store's.
var ownedErrors = map[error]error{
	thread.ErrNotFound:           plugin.ErrNotFound,
	thread.ErrInvalidArgument:    plugin.ErrInvalidArgument,
	thread.ErrFailedPrecondition: plugin.ErrFailedPrecondition,
	terminal.ErrNotFound:         plugin.ErrNotFound,
	terminal.ErrInvalidSpec:      plugin.ErrInvalidArgument,
}

func ownedErr(err error) error {
	for from, to := range ownedErrors {
		if errors.Is(err, from) {
			return kindError{kind: to, err: err}
		}
	}
	return err
}

func (p pluginThreads) Create(ctx context.Context, owner string, s plugin.ThreadSpec) (pluginsdk.PluginThread, error) {
	o := thread.CreateOptions{
		Owner: owner, Name: s.Title, Model: s.Model, Effort: s.Effort, InitialPrompt: s.Prompt,
		Env: s.Env, AddDirs: s.AddDirs,
	}
	if p.settings != nil {
		if snap := p.settings.Snapshot(); snap != nil {
			o.Model = cmp.Or(o.Model, snap.Settings.Threads.DefaultModel)
			o.Effort = cmp.Or(o.Effort, snap.Settings.Threads.DefaultEffort)
		}
	}
	if s.ProjectID != "" {
		o.ProjectID, o.WorktreePath = s.ProjectID, s.Cwd
	} else {
		o.NoProject, o.Cwd = true, s.Cwd
	}
	t, err := p.threads.Create(ctx, o)
	if err != nil {
		return pluginsdk.PluginThread{}, ownedErr(err)
	}
	return pluginThreadOf(t), nil
}

func (p pluginThreads) Send(ctx context.Context, id, text string) error {
	_, err := p.threads.Send(ctx, id, thread.Message{Text: text})
	return ownedErr(err)
}

func (p pluginThreads) Archive(ctx context.Context, id string) error {
	_, err := p.threads.Archive(ctx, id, true)
	return ownedErr(err)
}

// Remove is thread.remove's removal (the thread store's Remove): Claude stops first,
// then the thread, its items and its shells go; the usage moves to the retired ledger,
// and the Removed event drops it from every client.
func (p pluginThreads) Remove(ctx context.Context, id string) error {
	return ownedErr(p.threads.Remove(ctx, id))
}

func (p pluginThreads) Owner(id string) (string, bool) {
	t, ok := p.threads.Snapshot().Thread(id)
	return t.Owner, ok
}

func (p pluginThreads) Owned(owner string) []pluginsdk.PluginThread {
	var out []pluginsdk.PluginThread
	for _, t := range p.threads.Snapshot().Owned(owner) {
		out = append(out, pluginThreadOf(t))
	}
	return out
}

func (p pluginThreads) LiveOwners() []string {
	var out []string
	for _, t := range p.threads.Snapshot().Threads {
		if t.Owner != "" && t.ArchivedAt.IsZero() && !slices.Contains(out, t.Owner) {
			out = append(out, t.Owner)
		}
	}
	return out
}

// threadStates and threadStatuses are the protocol's words for the store's values.
var (
	threadStates = map[thread.State]string{
		thread.StateStarting: "starting", thread.StateConnected: "connected",
		thread.StateClosing: "closing", thread.StateDisconnected: "disconnected",
	}
	threadStatuses = map[thread.Status]string{
		thread.StatusBusy: "busy", thread.StatusIdle: "idle", thread.StatusNeedsAttention: "attention", thread.StatusError: "error",
	}
)

func pluginThreadOf(t thread.Thread) pluginsdk.PluginThread {
	return pluginsdk.PluginThread{
		ThreadID: t.ID, Title: t.Name, Cwd: t.WorktreePath, ProjectID: t.ProjectID, Model: t.Model, Effort: t.Effort,
		State: cmp.Or(threadStates[t.State], "unknown"), Status: cmp.Or(threadStatuses[t.Status], "unknown"),
		Archived: !t.ArchivedAt.IsZero(), CreatedAt: t.CreatedAt, CostUSD: thread.UsageCost(t.Usage),
	}
}

type pluginTerminals struct{ terminals terminal.Store }

var _ plugin.OwnedTerminals = pluginTerminals{}

func (p pluginTerminals) Create(ctx context.Context, name string, s plugin.TerminalSpec) (pluginsdk.PluginTerminal, error) {
	t, err := p.terminals.Create(ctx, terminal.Spec{Argv: s.Argv, Cwd: s.Cwd, Env: s.Env, Labels: termlabel.PluginTerminal(name, s.Title)})
	if err != nil {
		return pluginsdk.PluginTerminal{}, ownedErr(fmt.Errorf("start %s: %w", s.Argv[0], err))
	}
	return pluginTerminalOf(t), nil
}

func (p pluginTerminals) Close(ctx context.Context, id string) error {
	return ownedErr(terminal.KillAndRemove(ctx, p.terminals, id))
}

func (p pluginTerminals) Owner(id string) (string, bool) {
	t, err := p.terminals.Get(context.Background(), id)
	if err != nil {
		return "", false
	}
	if !termlabel.IsPlugin(t.Labels) {
		return "", true
	}
	return t.Labels[termlabel.Plugin], true
}

func (p pluginTerminals) Owned(name string) []pluginsdk.PluginTerminal {
	var out []pluginsdk.PluginTerminal
	for _, t := range p.terminals.List(context.Background()) {
		if termlabel.IsPlugin(t.Labels) && t.Labels[termlabel.Plugin] == name {
			out = append(out, pluginTerminalOf(t))
		}
	}
	return out
}

func (p pluginTerminals) Text(ctx context.Context, id string) (string, error) {
	text, err := p.terminals.ScreenText(ctx, id)
	return text, ownedErr(err)
}

func (p pluginTerminals) Scrollback(ctx context.Context, id string) (string, error) {
	text, err := p.terminals.ScrollbackText(ctx, id)
	return text, ownedErr(err)
}

func pluginTerminalOf(t terminal.Terminal) pluginsdk.PluginTerminal {
	out := pluginsdk.PluginTerminal{
		TerminalID: t.ID, Title: cmp.Or(t.Labels[termlabel.Title], t.Title), Argv: slices.Clone(t.Argv), Cwd: t.Cwd,
		State: t.State.String(), StartedAt: t.StartedAt,
	}
	if t.State == terminal.StateExited {
		out.ExitCode = t.ExitCode
	}
	return out
}
