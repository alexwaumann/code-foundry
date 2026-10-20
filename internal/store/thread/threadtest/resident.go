package threadtest

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// EnsureResident records "EnsureResident <name> <cwd>" and returns the resident thread
// named name, adding a stopped one (Kind resident, epoch 1, named DisplayName or name)
// when there is none. The cwd is not made.
func (f *Fake) EnsureResident(_ context.Context, name string, o thread.ResidentOptions) (thread.Thread, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("EnsureResident " + name + " " + o.Cwd); err != nil {
		return thread.Thread{}, false, err
	}
	for _, s := range f.byID {
		if s.Kind == thread.KindResident && s.ResidentName == name {
			return s, false, nil
		}
	}
	f.next++
	s := thread.Thread{ID: fmt.Sprintf("s-%d", f.next), Kind: thread.KindResident, ResidentName: name, Name: name, WorktreePath: o.Cwd,
		Model: o.Model, Effort: o.Effort, PermissionMode: o.PermissionMode, State: thread.StateDisconnected, Status: thread.StatusIdle,
		Epoch: 1, SystemPromptAppend: o.SystemPromptAppend, SpawnAddDirs: slices.Clone(o.AddDirs), CreatedAt: f.Now()}
	if o.DisplayName != "" {
		s.Name = o.DisplayName
	}
	s.LastActivityAt = s.CreatedAt
	f.byID[s.ID] = s
	f.rebuild()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: s})
	return s, true, nil
}

// refuseResident is the store's refusal of an action a resident thread does not take.
// Callers hold f.mu.
func (f *Fake) refuseResident(id, action string) error {
	if s, ok := f.byID[id]; ok && s.Kind == thread.KindResident {
		return fmt.Errorf("%w: thread %s is the resident %s thread; it cannot be %s", thread.ErrFailedPrecondition, id, s.ResidentName, action)
	}
	return nil
}

// Reseed records "Reseed <id> prompt=<bytes> dirs=<a,b> prefix=<bytes>" and applies the
// seed to the thread's row: one epoch on, a fresh next start, the context forgotten. A
// CONNECTED thread that is busy gets ReseedPending; one that is not is stopped
// (DISCONNECTED, reason "reseed", stopped). No validation.
func (f *Fake) Reseed(_ context.Context, id string, o thread.ReseedOptions) (thread.Thread, bool, error) {
	stopped := false
	call := fmt.Sprintf("Reseed %s prompt=%d dirs=%s prefix=%d", id, len(o.SystemPromptAppend), strings.Join(o.AddDirs, ","), len(o.Prefix))
	s, err := f.mutate(call, id, func(s *thread.Thread) error {
		s.SystemPromptAppend, s.SpawnAddDirs, s.SeedPrefix = o.SystemPromptAppend, slices.Clone(o.AddDirs), o.Prefix
		s.FreshStart, s.Epoch, s.ContextTokens = true, max(s.Epoch, 1)+1, 0
		if s.State == thread.StateConnected {
			if s.Status == thread.StatusBusy {
				s.ReseedPending = true
			} else {
				s.State, s.DisconnectReason, stopped = thread.StateDisconnected, thread.ReasonReseed, true
			}
		}
		return nil
	})
	return s, stopped, err
}
