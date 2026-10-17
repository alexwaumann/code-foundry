// Package actiontest provides an in-memory action.Store for tests of code that consumes
// actions (API handlers). Nothing runs: Run records its options and returns a run the
// test finishes with Finish.
package actiontest

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/action"
)

// Fake implements action.Store.
type Fake struct {
	bus *bus.Bus
	// Err, when set, is returned by every mutation and Run.
	Err error

	mu      sync.Mutex
	next    int
	actions []action.Action
	runs    []action.Run
	done    map[string]chan struct{}
	// Ran records Run's options in order.
	ran []action.RunOptions
}

var _ action.Store = (*Fake)(nil)

// New returns an empty fake publishing on b (a private bus if nil).
func New(b *bus.Bus) *Fake {
	if b == nil {
		b = bus.New()
	}
	return &Fake{bus: b, done: map[string]chan struct{}{}}
}

// Snapshot implements action.Store.
func (f *Fake) Snapshot() *action.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot()
}

func (f *Fake) snapshot() *action.Snapshot {
	as := slices.Clone(f.actions)
	slices.SortFunc(as, func(a, b action.Action) int {
		return cmp.Or(cmp.Compare(a.ProjectID, b.ProjectID), cmp.Compare(a.Position, b.Position))
	})
	rs := make([]action.Run, len(f.runs))
	for i, r := range f.runs {
		r.Output = ""
		rs[len(f.runs)-1-i] = r
	}
	return &action.Snapshot{Actions: as, Runs: rs}
}

func (f *Fake) id(prefix string) string {
	f.next++
	return prefix + strconv.Itoa(f.next)
}

// Create implements action.Store (no validation beyond a name clash).
func (f *Fake) Create(_ context.Context, o action.CreateOptions) (action.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return action.Action{}, f.Err
	}
	n := 0
	for _, a := range f.actions {
		if a.ProjectID == o.ProjectID {
			if strings.EqualFold(a.Name, o.Name) {
				return action.Action{}, fmt.Errorf("%w: name %q taken", action.ErrFailedPrecondition, o.Name)
			}
			n++
		}
	}
	a := action.Action{
		ID: f.id("a-"), ProjectID: o.ProjectID, Name: o.Name, Command: o.Command, Icon: cmp.Or(o.Icon, action.IconPlay),
		InTerminal: o.InTerminal, OnWorktreeCreate: o.OnWorktreeCreate, Position: n, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	f.actions = append(f.actions, a)
	bus.Publish[action.Event](f.bus, action.Updated{Action: a})
	return a, nil
}

// Update implements action.Store (Position is ignored).
func (f *Fake) Update(_ context.Context, o action.UpdateOptions) (action.Action, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return action.Action{}, f.Err
	}
	i := slices.IndexFunc(f.actions, func(a action.Action) bool { return a.ID == o.ID })
	if i < 0 {
		return action.Action{}, fmt.Errorf("%w: action %q", action.ErrNotFound, o.ID)
	}
	a := &f.actions[i]
	set := func(dst *string, src *string) {
		if src != nil {
			*dst = *src
		}
	}
	set(&a.Name, o.Name)
	set(&a.Command, o.Command)
	set(&a.Icon, o.Icon)
	if o.InTerminal != nil {
		a.InTerminal = *o.InTerminal
	}
	if o.OnWorktreeCreate != nil {
		a.OnWorktreeCreate = *o.OnWorktreeCreate
	}
	bus.Publish[action.Event](f.bus, action.Updated{Action: *a})
	return *a, nil
}

// Delete implements action.Store.
func (f *Fake) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return f.Err
	}
	i := slices.IndexFunc(f.actions, func(a action.Action) bool { return a.ID == id })
	if i < 0 {
		return fmt.Errorf("%w: action %q", action.ErrNotFound, id)
	}
	f.actions = slices.Delete(f.actions, i, i+1)
	bus.Publish[action.Event](f.bus, action.Removed{ID: id})
	return nil
}

// Run implements action.Store: it resolves the action by id, else by name in o.ProjectID,
// records o, and returns a running run (ModeBackground unless o.Mode says otherwise).
func (f *Fake) Run(_ context.Context, o action.RunOptions) (action.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Err != nil {
		return action.Run{}, f.Err
	}
	a, err := f.snapshot().Resolve(o.ProjectID, o.Action)
	if err != nil {
		return action.Run{}, err
	}
	f.ran = append(f.ran, o)
	r := action.Run{
		ID: f.id("r-"), ActionID: a.ID, ActionName: a.Name, Command: a.Command, ProjectID: a.ProjectID,
		ThreadID: o.ThreadID, Worktree: o.Worktree, Mode: cmp.Or(o.Mode, action.ModeBackground),
		Trigger: action.TriggerUser, State: action.RunRunning, StartedAt: time.Now(),
	}
	if r.Mode == action.ModeTerminal {
		r.TerminalID = "t-" + r.ID
	}
	f.runs = append(f.runs, r)
	f.done[r.ID] = make(chan struct{})
	bus.Publish[action.Event](f.bus, action.RunUpdated{Run: r})
	return r, nil
}

// Ran returns the options Run was called with.
func (f *Fake) Ran() []action.RunOptions {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ran)
}

// Finish ends run id with code and output, publishing RunUpdated and RunFinished.
func (f *Fake) Finish(id string, code int, output string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.runs, func(r action.Run) bool { return r.ID == id })
	if i < 0 {
		return fmt.Errorf("%w: run %q", action.ErrNotFound, id)
	}
	r := &f.runs[i]
	r.State, r.ExitCode, r.Output, r.FinishedAt = action.RunExited, code, output, time.Now()
	close(f.done[id])
	pub := *r
	pub.Output = ""
	bus.Publish[action.Event](f.bus, action.RunUpdated{Run: pub})
	bus.Publish[action.Event](f.bus, action.RunFinished{
		RunID: r.ID, ActionID: r.ActionID, ActionName: r.ActionName, ProjectID: r.ProjectID, ThreadID: r.ThreadID,
		TerminalID: r.TerminalID, Mode: r.Mode, Trigger: r.Trigger, ExitCode: code,
	})
	return nil
}

// GetRun implements action.Store.
func (f *Fake) GetRun(_ context.Context, id string) (action.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.runs, func(r action.Run) bool { return r.ID == id })
	if i < 0 {
		return action.Run{}, fmt.Errorf("%w: run %q", action.ErrNotFound, id)
	}
	return f.runs[i], nil
}

// Wait implements action.Store.
func (f *Fake) Wait(ctx context.Context, id string) (action.Run, error) {
	f.mu.Lock()
	done, ok := f.done[id]
	f.mu.Unlock()
	if !ok {
		return action.Run{}, fmt.Errorf("%w: run %q", action.ErrNotFound, id)
	}
	select {
	case <-done:
		return f.GetRun(ctx, id)
	case <-ctx.Done():
		return action.Run{}, ctx.Err()
	}
}
