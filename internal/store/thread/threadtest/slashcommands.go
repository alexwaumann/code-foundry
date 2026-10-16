package threadtest

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// PutSlashCommands sets a thread's slash commands (nil: none, not running) and
// publishes SlashCommandsChanged.
func (f *Fake) PutSlashCommands(id string, cs []thread.SlashCommand) {
	f.mu.Lock()
	snap, ok := f.items[id]
	if !ok {
		snap = &thread.ItemsSnapshot{SessionID: id}
		f.items[id] = snap
	}
	snap.Seq++
	snap.Commands = cs
	ev := thread.SlashCommandsChanged{SessionID: id, Seq: snap.Seq, Commands: cs}
	f.mu.Unlock()
	bus.Publish[thread.ThreadEvent](f.bus, ev)
}

// SlashCommands records "SlashCommands <id>" and returns what PutSlashCommands left.
func (f *Fake) SlashCommands(_ context.Context, id string) ([]thread.SlashCommand, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("SlashCommands " + id); err != nil {
		return nil, err
	}
	if _, err := f.get(id); err != nil {
		return nil, err
	}
	return f.itemsLocked(id).Commands, nil
}
