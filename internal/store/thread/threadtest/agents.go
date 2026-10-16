package threadtest

import (
	"slices"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// PutAgents sets a thread's subagent runs (ItemsSnapshot.Agents) and publishes
// AgentsChanged.
func (f *Fake) PutAgents(id string, runs ...thread.AgentRun) {
	f.mu.Lock()
	snap, ok := f.items[id]
	if !ok {
		snap = &thread.ItemsSnapshot{SessionID: id}
		f.items[id] = snap
	}
	snap.Seq++
	snap.Agents = slices.Clone(runs)
	ev := thread.AgentsChanged{SessionID: id, Seq: snap.Seq, Agents: snap.Agents}
	f.mu.Unlock()
	bus.Publish[thread.ThreadEvent](f.bus, ev)
}
