package thread

import (
	"context"
	"slices"
	"strings"
)

// Hooks a resident agent's store sets on the thread store (docs/notes/ember-2-store.md),
// so the thread store never imports it: the model and effort of the threads a resident
// (or a thread below it) creates, the resident's own pre-allowed commands, and a note
// its wakes end with (docs/notes/ember-fixes-3-board.md).

// CreateDefaultsFunc picks the model and effort of a thread createdBy creates without
// choosing them (CreateOptions.Model empty or ModelDefaulted; likewise effort). needModel
// and needEffort say which are open; an empty answer leaves that one as it is. It runs
// inside Create, before anything is made, and must not call back into the store but
// for Snapshot.
type CreateDefaultsFunc func(ctx context.Context, createdBy string, needModel, needEffort bool) (model, effort string)

// SetCreateDefaults sets (nil: removes) the create defaults.
func (m *Manager) SetCreateDefaults(fn CreateDefaultsFunc) {
	if fn == nil {
		m.createDefaults.Store(nil)
		return
	}
	m.createDefaults.Store(&fn)
}

// applyCreateDefaults fills o's open model and effort from the create defaults when a
// thread (creatorID) creates it, and validates what it filled in.
func (m *Manager) applyCreateDefaults(ctx context.Context, creatorID string, o *CreateOptions) error {
	fn := m.createDefaults.Load()
	if fn == nil || creatorID == "" {
		return nil
	}
	needModel, needEffort := o.Model == "" || o.ModelDefaulted, o.Effort == "" || o.EffortDefaulted
	if !needModel && !needEffort {
		return nil
	}
	model, effort := (*fn)(ctx, creatorID, needModel, needEffort)
	if needModel && model != "" {
		o.Model = model
	}
	if needEffort && effort != "" {
		o.Effort = effort
	}
	if model == "" && effort == "" {
		return nil
	}
	m.log.Info("creator's defaults for a new thread", "created_by", creatorID, "model", o.Model, "effort", o.Effort)
	return validateModelEffort(o.Model, o.Effort)
}

// ResidentTools are a resident's own permission rules, on every spawn of it: Allow after
// the protocol's --allowedTools (ProtocolAllowedTools), Deny as --disallowedTools.
type ResidentTools struct {
	Allow, Deny []string
}

// SetResidentTools sets the permission rules ("Bash(code-foundry ember:*)") of the
// resident named name; the zero value removes them. In memory: its store sets them at
// every daemon start, before the resident can start. A running process keeps the rules
// it was started with.
func (m *Manager) SetResidentTools(name string, t ResidentTools) {
	if len(t.Allow) == 0 && len(t.Deny) == 0 {
		m.residentTools.Delete(name)
		return
	}
	m.residentTools.Store(name, ResidentTools{Allow: slices.Clone(t.Allow), Deny: slices.Clone(t.Deny)})
}

// residentRules are fresh slices of the resident rules for s; empty for a thread that is
// not a resident or has none.
func (m *Manager) residentRules(s Thread) (allow, deny []string) {
	if s.Kind != KindResident {
		return nil, nil
	}
	v, ok := m.residentTools.Load(s.ResidentName)
	if !ok {
		return nil, nil
	}
	t := v.(ResidentTools)
	return slices.Clone(t.Allow), slices.Clone(t.Deny)
}

// WakeNoteFunc is what a resident's store adds at the end of a wake to its resident
// thread (Ember lists the tasks still waiting on its check): about are the threads the
// wake reports on (none for a timer, a pull request or an action run); "" adds nothing.
// It runs on the wake's delivery goroutine with none of the store's locks held, and must
// not call back into the store but for Snapshot.
type WakeNoteFunc func(about []string) string

// SetResidentWakeNote sets (nil: removes) the wake note of the resident named name.
func (m *Manager) SetResidentWakeNote(name string, fn WakeNoteFunc) {
	if fn == nil {
		m.wakeNotes.Delete(name)
		return
	}
	m.wakeNotes.Store(name, fn)
}

// withWakeNote is the wake msg to subscriber with its resident's wake note after it, a
// paragraph of its text; msg as it is for a thread that is not a resident or whose
// resident has no note now.
func (m *Manager) withWakeNote(subscriber string, msg Message, about []string) Message {
	t, ok := m.Snapshot().Thread(subscriber)
	if !ok || t.Kind != KindResident {
		return msg
	}
	v, ok := m.wakeNotes.Load(t.ResidentName)
	if !ok {
		return msg
	}
	if note := strings.TrimSpace(v.(WakeNoteFunc)(about)); note != "" {
		msg.Text += "\n\n" + note
	}
	return msg
}
