package sessiontest

import (
	"slices"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// PutAgents sets a thread's subagent runs (ItemsSnapshot.Agents) and publishes
// AgentsChanged.
func (f *Fake) PutAgents(id string, runs ...session.AgentRun) {
	f.mu.Lock()
	snap, ok := f.items[id]
	if !ok {
		snap = &session.ItemsSnapshot{SessionID: id}
		f.items[id] = snap
	}
	snap.Seq++
	snap.Agents = slices.Clone(runs)
	ev := session.AgentsChanged{SessionID: id, Seq: snap.Seq, Agents: snap.Agents}
	f.mu.Unlock()
	bus.Publish[session.ThreadEvent](f.bus, ev)
}
