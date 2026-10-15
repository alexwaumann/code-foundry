package session

import (
	"context"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// A thread's slash commands (docs/notes/slash-commands-1-daemon.md): the list Claude
// reports in its initialize reply, replaced by every system/commands_changed push, minus
// the deny table (slashdeny.go). Cached on the thread's log and persisted
// (threadcache_db.go): a thread whose process stopped (lifecycle.go) keeps offering the
// last list, also across a daemon restart, until the next handshake replaces it. Every
// change is a SlashCommandsChanged event in the thread's seq order, so
// ThreadService.Watch carries it.

// SlashCommand is one slash command a thread offers. A value: never mutate one
// read from a snapshot or an event.
type SlashCommand struct {
	// Name is what follows "/" ("compact", "anthropic-skills:deep-research").
	Name string
	// Description is Claude's (a project skill's ends in " (project)").
	Description string
	// ArgumentHint is shown after the name ("[interval] [prompt]"); "" for none.
	ArgumentHint string
	// Aliases are other names that run it ("/cost" runs usage).
	Aliases []string
	// Builtin marks Claude Code's own commands, bundled skills included; false for
	// user, project and plugin skills and commands.
	Builtin bool
}

// SlashCommandsChanged is published on the bus (as a ThreadEvent) when a thread's slash
// commands changed: Claude answered initialize with a different list, or pushed a new
// one. Commands nil: none (a thread whose Claude never answered a handshake).
type SlashCommandsChanged struct {
	SessionID string
	Seq       uint64
	Commands  []SlashCommand
}

func (SlashCommandsChanged) isThreadEvent() {}

// Thread implements ThreadEvent.
func (e SlashCommandsChanged) Thread() string { return e.SessionID }

// visibleSlashCommands is what the composer offers of Claude's list, in Claude's order
// (its skills first, then its built-ins, then plugin skills): one row per name (the
// built-in one when rows share a name, since "/name" runs it, else the first), minus
// the built-ins the deny table names. Never nil.
func visibleSlashCommands(in []claudestream.SlashCommand) []SlashCommand {
	runs := map[string]int{} // name -> index in `in` of the row "/name" runs
	for i, c := range in {
		if j, ok := runs[c.Name]; !ok || (c.Builtin && !in[j].Builtin) {
			runs[c.Name] = i
		}
	}
	out := make([]SlashCommand, 0, len(in))
	for i, c := range in {
		if runs[c.Name] != i {
			continue
		}
		if _, denied := DeniedSlashCommand(c.Name, c.Description); denied && c.Builtin {
			continue
		}
		out = append(out, SlashCommand{
			Name: c.Name, Description: c.Description, ArgumentHint: c.ArgumentHint,
			Aliases: slices.Clone(c.Aliases), Builtin: c.Builtin,
		})
	}
	return out
}

func sameSlashCommands(a, b []SlashCommand) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	return slices.EqualFunc(a, b, func(x, y SlashCommand) bool {
		return x.Name == y.Name && x.Description == y.Description && x.ArgumentHint == y.ArgumentHint &&
			x.Builtin == y.Builtin && slices.Equal(x.Aliases, y.Aliases)
	})
}

// setSlashCommands caches cs (nil: none), publishes the change, if it is one, and
// persists it.
func (t *threadLog) setSlashCommands(cs []SlashCommand) {
	t.mu.Lock()
	if sameSlashCommands(t.commands, cs) {
		t.mu.Unlock()
		return
	}
	t.commands = cs
	t.seq++
	bus.Publish[ThreadEvent](t.bus, SlashCommandsChanged{SessionID: t.id, Seq: t.seq, Commands: cs})
	t.mu.Unlock()
	if t.saveCommands != nil {
		t.saveCommands(cs)
	}
}

// offersSlashCommand reports whether the thread offers a command called name.
func (t *threadLog) offersSlashCommand(name string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return slices.ContainsFunc(t.commands, func(c SlashCommand) bool { return c.Name == name })
}

func (t *threadLog) slashCommands() []SlashCommand {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.commands
}

// onSlashCommands takes a list from Claude: initialize's reply (pushed false) or a
// system/commands_changed (pushed true). The handshake's answer and the event stream
// reach the runner on different channels, so a push can be handled before the reply
// that preceded it on stdout: once a process pushed, its handshake's list is stale.
func (r *runner) onSlashCommands(cs []claudestream.SlashCommand, pushed bool) {
	st := r.st
	if r.closing || (!pushed && st.commandsPushed) {
		return
	}
	st.commandsPushed = st.commandsPushed || pushed
	st.log.setSlashCommands(visibleSlashCommands(cs))
}

// SlashCommands implements Store.
func (m *Manager) SlashCommands(ctx context.Context, id string) ([]SlashCommand, error) {
	log, err := m.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	return log.slashCommands(), nil
}
