package command

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
)

// ember.* (docs/notes/ember-2-store.md): Ember, the resident agent. Its task board, its
// memory and its epochs, for Ember itself (it runs the CLI from its thread) and for the
// user's CLI; the GUI reads the board through EmberService. Palette-hidden
// (keys/bindings.ts): CLI first.

// EmberBackend is the Ember store (*ember.Store) as the ember.* commands use it.
type EmberBackend interface {
	Snapshot() *ember.Snapshot
	Dir() string
	TaskIDs() []string
	CheckTask(n ember.NewTask) error
	AddTask(ctx context.Context, n ember.NewTask) (ember.Task, error)
	UpdateTask(ctx context.Context, id string, u ember.TaskUpdate) (ember.Task, error)
	Remember(fact string) (string, error)
	Reseed(ctx context.Context) (ember.Status, error)
	Await(ctx context.Context, done func(*ember.Snapshot) bool) (*ember.Snapshot, error)
}

var _ EmberBackend = (*ember.Store)(nil)

// EmberDeps are the ember.* commands' dependencies: the store, the settings for
// ember.enable and ember.disable, and the thread store for ember.task.done's branch
// check (ember.task.start creates its worker through thread.new in the registry).
type EmberDeps struct {
	Ember    EmberBackend
	Settings SettingsBackend
	Thread   ThreadBackend
	// RemoteBranch reports whether origin/<branch> exists in a worktree. Default: git
	// rev-parse there.
	RemoteBranch func(ctx context.Context, worktree, branch string) (bool, error)
	// NewTaskID makes the id of a task ember.task.start adds once its worker started.
	// Default ember.NewTaskID.
	NewTaskID func() (string, error)
	// Now is the clock of the board's times. Default time.Now.
	Now func() time.Time
}

// emberCategory is the commands' category (and guide topic).
const emberCategory = "Ember"

// emberEnabledKey is the setting ember.enable and ember.disable set (settings imports
// this package, so its constant is not reachable here).
const emberEnabledKey = "ember.enabled"

// emberEnableWait bounds how long ember.enable waits for the resident thread.
const emberEnableWait = 10 * time.Second

// RegisterEmber registers ember.status, ember.board, ember.remember, ember.reseed,
// ember.enable, ember.disable and the ember.task.* commands. ember.task.start invokes
// thread.new through r.
func RegisterEmber(r *Registry, d EmberDeps) error {
	if d.Ember == nil {
		d.Ember = noEmber{}
	}
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.RemoteBranch == nil {
		d.RemoteBranch = gitRemoteBranch
	}
	if d.NewTaskID == nil {
		d.NewTaskID = ember.NewTaskID
	}
	r.SetIDLister(EmberTaskID, func(context.Context) ([]string, error) { return d.Ember.TaskIDs(), nil })
	setEnabled := func(ctx context.Context, on bool) (Result, error) {
		if d.Settings == nil {
			return Result{}, connect.NewError(connect.CodeUnimplemented, errors.New("no settings store"))
		}
		if _, err := d.Settings.Update(ctx, connect.NewRequest(&v1.UpdateSettingsRequest{
			Values: map[string]string{emberEnabledKey: fmt.Sprint(on)},
		})); err != nil {
			return Result{}, err
		}
		wctx, cancel := context.WithTimeout(ctx, emberEnableWait)
		defer cancel()
		snap, err := d.Ember.Await(wctx, func(s *ember.Snapshot) bool { return s.Status.Enabled == on && (!on || s.Status.ThreadID != "") })
		if err != nil && ctx.Err() != nil {
			return Result{}, err
		}
		v := emberStatusView(snap.Status, d.Ember.Dir(), d.Now())
		if !on {
			return Result{Message: "Ember is off; its thread stays (" + snap.Status.ThreadID + ")", JSON: v}, nil
		}
		if snap.Status.ThreadID == "" {
			return Result{Message: "Ember is on; its thread is being made (code-foundry ember status)", JSON: v}, nil
		}
		return Result{Message: "Ember is on: thread " + snap.Status.ThreadID + " in " + d.Ember.Dir(), JSON: v}, nil
	}
	return errors.Join(r.RegisterAll(
		Command{
			Name:         "ember.status",
			Title:        "Ember: Status",
			Description:  "Whether Ember is on, its thread, its epoch (fresh sessions so far), the context size against the epoch limit, the epoch's age and its open tasks.",
			Category:     emberCategory,
			NoKeybinding: true,
			Run: func(context.Context, Context, Args) (Result, error) {
				v := emberStatusView(d.Ember.Snapshot().Status, d.Ember.Dir(), d.Now())
				return Result{Message: formatEmberStatus(v), JSON: v}, nil
			},
		},
		Command{
			Name:         "ember.board",
			Title:        "Ember: Board",
			Description:  "Print Ember's task board as markdown: in progress, up next, blocked and done today, with ids and each worker's progress.",
			Category:     emberCategory,
			NoKeybinding: true,
			Run: func(context.Context, Context, Args) (Result, error) {
				snap := d.Ember.Snapshot()
				return Result{Message: strings.TrimRight(ember.RenderBoard(snap.Tasks, snap.Timers, d.Now(), time.Local), "\n"), JSON: emberTaskViews(snap.Tasks, d.Now())}, nil
			},
		},
		Command{
			Name:  "ember.remember",
			Title: "Ember: Remember",
			Description: "Keep a fact in Ember's memory now: a dated line under MEMORY.md's Notes, kept across epochs " +
				"(a convention, a decision, a person). The rest of the memory is rewritten at each new epoch. " +
				"A preference about how threads behave in the app goes to memory.add, which every thread gets.",
			Category:     emberCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "fact", Type: String, Required: true, Positional: true, Description: "The fact, one line (at most 1000 characters)"}},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				line, err := d.Ember.Remember(a.String("fact"))
				if err != nil {
					return Result{}, emberErr("fact", err)
				}
				return Result{Message: "remembered: " + line, JSON: map[string]string{"line": line}}, nil
			},
		},
		Command{
			Name:  "ember.reseed",
			Title: "Ember: New Epoch",
			Description: "Start a new epoch now: consolidate Ember's memory (a one-shot claude -p), rebuild its seed and give it a " +
				"fresh session. Its next message starts the new session; a running turn ends first.",
			Category:     emberCategory,
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				st, err := d.Ember.Reseed(ctx)
				if err != nil {
					return Result{}, emberErr("", err)
				}
				v := emberStatusView(st, d.Ember.Dir(), d.Now())
				msg := fmt.Sprintf("Ember is in epoch %d; its next message starts a fresh session", st.Epoch)
				if st.LastConsolidationError != "" {
					msg += " (its memory was kept as it was: " + st.LastConsolidationError + ")"
				}
				return Result{Message: msg, JSON: v}, nil
			},
		},
		Command{
			Name:         "ember.enable",
			Title:        "Ember: Turn On",
			Description:  "Turn Ember on (the ember.enabled setting): its thread is made on first use, in ~/.code-foundry/residents/ember.",
			Category:     emberCategory,
			NoKeybinding: true,
			Run:          func(ctx context.Context, _ Context, _ Args) (Result, error) { return setEnabled(ctx, true) },
		},
		Command{
			Name:         "ember.disable",
			Title:        "Ember: Turn Off",
			Description:  "Turn Ember off (the ember.enabled setting): its process stops and its timers go; its thread, memory and board stay.",
			Category:     emberCategory,
			NoKeybinding: true,
			Run:          func(ctx context.Context, _ Context, _ Args) (Result, error) { return setEnabled(ctx, false) },
		},
	), registerEmberTasks(r, d))
}

// emberErr maps an Ember store error: a bad argument is arg's (or the command's)
// InvalidArgument, a missing task NotFound, a refusal FailedPrecondition.
func emberErr(arg string, err error) error {
	switch {
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || connect.CodeOf(err) != connect.CodeUnknown:
		return err
	case errors.Is(err, ember.ErrInvalidArgument):
		return InvalidArg(arg, "%s", err)
	case errors.Is(err, ember.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, ember.ErrFailedPrecondition):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return Failed(err)
}

// EmberStatusView is ember.status's JSON.
type EmberStatusView struct {
	Enabled                bool            `json:"enabled"`
	ThreadID               string          `json:"threadId,omitempty"`
	Dir                    string          `json:"dir"`
	Epoch                  int             `json:"epoch,omitempty"`
	EpochStartedAt         *time.Time      `json:"epochStartedAt,omitempty"`
	EpochAgeSeconds        int64           `json:"epochAgeSeconds,omitempty"`
	ContextTokens          int64           `json:"contextTokens"`
	EpochContextTokens     int64           `json:"epochContextTokens"`
	Consolidating          bool            `json:"consolidating,omitempty"`
	LastConsolidatedAt     *time.Time      `json:"lastConsolidatedAt,omitempty"`
	LastConsolidationError string          `json:"lastConsolidationError,omitempty"`
	Counts                 EmberCountsView `json:"counts"`
	OpenTasks              int             `json:"openTasks"`

	// Consolidation is what memory consolidations cost (ember_consolidation_usage.go).
	Consolidation *EmberConsolidationView `json:"consolidation,omitempty"`
}

// EmberCountsView is the tasks per state in the JSON.
type EmberCountsView struct {
	Todo      int `json:"todo"`
	Doing     int `json:"doing"`
	Blocked   int `json:"blocked"`
	Done      int `json:"done"`
	Cancelled int `json:"cancelled"`
}

func emberStatusView(s ember.Status, dir string, now time.Time) EmberStatusView {
	v := EmberStatusView{
		Enabled: s.Enabled, ThreadID: s.ThreadID, Dir: dir, Epoch: s.Epoch, ContextTokens: s.ContextTokens,
		EpochContextTokens: s.EpochContextTokens, Consolidating: s.Consolidating, LastConsolidationError: s.LastConsolidationError,
		Counts:    EmberCountsView{Todo: s.Counts.Todo, Doing: s.Counts.Doing, Blocked: s.Counts.Blocked, Done: s.Counts.Done, Cancelled: s.Counts.Cancelled},
		OpenTasks: s.Counts.Todo + s.Counts.Doing + s.Counts.Blocked,
	}
	v.Consolidation = emberConsolidationView(s)
	if !s.EpochStartedAt.IsZero() {
		at := s.EpochStartedAt
		v.EpochStartedAt, v.EpochAgeSeconds = &at, int64(now.Sub(at)/time.Second)
	}
	if !s.LastConsolidatedAt.IsZero() {
		at := s.LastConsolidatedAt
		v.LastConsolidatedAt = &at
	}
	return v
}

// formatEmberStatus is ember.status's text.
func formatEmberStatus(v EmberStatusView) string {
	var b strings.Builder
	state := "off"
	if v.Enabled {
		state = "on"
	}
	fmt.Fprintf(&b, "Ember: %s (%s)\n", state, v.Dir)
	if v.ThreadID == "" {
		b.WriteString("thread: none yet (code-foundry ember enable)\n")
	} else {
		epoch := fmt.Sprintf("epoch %d", v.Epoch)
		if v.EpochStartedAt != nil {
			epoch += fmt.Sprintf(" since %s (%s)", v.EpochStartedAt.Local().Format("Jan 2 15:04"), ember.Age(time.Duration(v.EpochAgeSeconds)*time.Second))
		}
		fmt.Fprintf(&b, "thread: %s, %s, context %s of %s tokens\n", v.ThreadID, epoch, compactTokens(v.ContextTokens), compactTokens(v.EpochContextTokens))
	}
	c := v.Counts
	fmt.Fprintf(&b, "tasks: %d doing, %d todo, %d blocked, %d done, %d cancelled\n", c.Doing, c.Todo, c.Blocked, c.Done, c.Cancelled)
	switch {
	case v.Consolidating:
		b.WriteString("a new epoch is being prepared (consolidating its memory)\n")
	case v.LastConsolidatedAt != nil && v.LastConsolidationError != "":
		fmt.Fprintf(&b, "last consolidation %s failed: %s\n", v.LastConsolidatedAt.Local().Format("Jan 2 15:04"), v.LastConsolidationError)
	case v.LastConsolidatedAt != nil:
		fmt.Fprintf(&b, "last consolidation %s\n", v.LastConsolidatedAt.Local().Format("Jan 2 15:04"))
	}
	b.WriteString(emberConsolidationLine(v.Consolidation))
	return strings.TrimRight(b.String(), "\n")
}

// compactTokens is n as "45.2K" or "1.2M".
func compactTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1000:
		return fmt.Sprintf("%.1fK", float64(n)/1e3)
	}
	return fmt.Sprint(n)
}

// noEmber is the backend without an Ember store: everything fails with Unimplemented,
// so the commands still list.
type noEmber struct{}

var errNoEmber = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no Ember store"))

func (noEmber) Snapshot() *ember.Snapshot     { return &ember.Snapshot{} }
func (noEmber) Dir() string                   { return "" }
func (noEmber) TaskIDs() []string             { return nil }
func (noEmber) CheckTask(ember.NewTask) error { return errNoEmber }
func (noEmber) AddTask(context.Context, ember.NewTask) (ember.Task, error) {
	return ember.Task{}, errNoEmber
}
func (noEmber) UpdateTask(context.Context, string, ember.TaskUpdate) (ember.Task, error) {
	return ember.Task{}, errNoEmber
}
func (noEmber) Remember(string) (string, error)              { return "", errNoEmber }
func (noEmber) Reseed(context.Context) (ember.Status, error) { return ember.Status{}, errNoEmber }
func (noEmber) Await(ctx context.Context, _ func(*ember.Snapshot) bool) (*ember.Snapshot, error) {
	return &ember.Snapshot{}, errNoEmber
}
