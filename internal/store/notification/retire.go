package notification

import (
	"context"
	"slices"
)

// Retire withdraws source's notification with key whatever its state, and reports whether
// it changed one. Withdraw leaves a dismissed or resolved notification as it is, so the
// same content posted again stays closed; Retire is for a source whose condition has
// cleared, so that the condition coming back later is a new arrival even when the user
// dismissed the last one (docs/notes/notifications-plugin-health.md). A key with nothing,
// or with a withdrawn one, is false and no write.
func (m *Manager) Retire(ctx context.Context, source, key string) (bool, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.byID[m.byKey[keyOf(source, key)]]
	if !ok || n.State == StateWithdrawn {
		return false, nil
	}
	w := *n
	w.State, w.UpdatedAt = StateWithdrawn, now
	if err := m.commit(ctx, change{saved: []Notification{w}}); err != nil {
		return false, err
	}
	return true, nil
}

// Keys returns source's keys whose notification is not withdrawn (active, dismissed or
// resolved), sorted: what Retire would change.
func (m *Manager) Keys(source string) []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for _, n := range m.byID {
		if n.Source == source && n.State != StateWithdrawn {
			out = append(out, n.Key)
		}
	}
	slices.Sort(out)
	return out
}
