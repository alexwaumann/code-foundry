package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

// MemoryBackend is the app memory the memory.* commands read and write: the user's
// standing preferences, which every thread's system prompt carries from its next start
// (docs/notes/control-3-app-memory.md). *memory.Store implements it.
type MemoryBackend interface {
	Entries() ([]memory.Entry, error)
	Add(text string) (memory.Added, error)
	Remove(ref string) (memory.Entry, error)
	Clear() (int, error)
}

var _ MemoryBackend = (*memory.Store)(nil)

// memoryApplies ends the message of a change: claude records the system prompt on a
// conversation's first request, so running threads keep what they started with.
const memoryApplies = "applies to threads started from now on"

// MemoryView is memory.show's JSON.
type MemoryView struct {
	Entries []memory.Entry `json:"entries"`
}

// MemoryAddView is memory.add's JSON: the entry, and whether it was added (false: the
// memory had it already).
type MemoryAddView struct {
	Entry memory.Entry `json:"entry"`
	Added bool         `json:"added"`
}

// MemoryRemoveView is memory.remove's JSON.
type MemoryRemoveView struct {
	Removed memory.Entry `json:"removed"`
}

// MemoryClearView is memory.clear's JSON: how many entries were forgotten.
type MemoryClearView struct {
	Removed int `json:"removed"`
}

// RegisterMemory registers memory.show, memory.add, memory.remove and memory.clear. A
// nil backend registers them failing with Unimplemented.
func RegisterMemory(r *Registry, b MemoryBackend) error {
	if b == nil {
		b = noMemory{}
	}
	return r.RegisterAll(
		Command{
			Name:  "memory.show",
			Title: "Memory: Show Preferences",
			Description: "List the user's standing preferences about Code Foundry and how the model behaves in it, numbered. " +
				"Every thread's system prompt carries them from its start.",
			Category:     "Settings",
			NoKeybinding: true,
			Run: func(context.Context, Context, Args) (Result, error) {
				entries, err := b.Entries()
				if err != nil {
					return Result{}, memoryErr("", err)
				}
				if entries == nil {
					entries = []memory.Entry{}
				}
				return Result{Message: formatMemory(entries), JSON: MemoryView{Entries: entries}}, nil
			},
		},
		Command{
			Name:  "memory.add",
			Title: "Memory: Remember a Preference",
			Description: "Remember a standing preference (\"always open PRs as drafts\") for every thread in every project, " +
				"in the user's words. It reaches threads started from now on. At most 40 entries and 4 KiB in all; " +
				"text the memory has already is not added again.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{{Name: "text", Type: String, Required: true, Positional: true,
				Description: "The preference, one line"}},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				added, err := b.Add(a.String("text"))
				if err != nil {
					return Result{}, memoryErr("text", err)
				}
				e := added.Entry
				if added.Duplicate {
					return Result{Message: fmt.Sprintf("already remembered as #%d: %s (nothing changed)", e.Index, e.Text),
						JSON: MemoryAddView{Entry: e}}, nil
				}
				return Result{Message: fmt.Sprintf("remembered #%d: %s; %s", e.Index, e.Text, memoryApplies),
					JSON: MemoryAddView{Entry: e, Added: true}}, nil
			},
		},
		Command{
			Name:  "memory.remove",
			Title: "Memory: Forget a Preference",
			Description: "Forget one remembered preference, by its number in `memory show` or by text found in it alone. " +
				"Threads started from now on no longer get it.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{{Name: "entry", Type: String, Required: true, Positional: true,
				Description: "The entry's number in memory show, or text that only that entry contains"}},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				e, err := b.Remove(a.String("entry"))
				if err != nil {
					return Result{}, memoryErr("entry", err)
				}
				return Result{Message: fmt.Sprintf("forgot #%d: %s; %s", e.Index, e.Text, memoryApplies),
					JSON: MemoryRemoveView{Removed: e}}, nil
			},
		},
		Command{
			Name:         "memory.clear",
			Title:        "Memory: Forget All Preferences",
			Description:  "Forget every remembered preference. Threads started from now on get none.",
			Category:     "Settings",
			NoKeybinding: true,
			Confirm:      "Forget every remembered preference? Threads started from now on get none.",
			Run: func(context.Context, Context, Args) (Result, error) {
				n, err := b.Clear()
				if err != nil {
					return Result{}, memoryErr("", err)
				}
				if n == 0 {
					return Result{Message: "no preferences to forget", JSON: MemoryClearView{}}, nil
				}
				return Result{Message: fmt.Sprintf("forgot %s; %s", plural(n, "preference"), memoryApplies),
					JSON: MemoryClearView{Removed: n}}, nil
			},
		},
	)
}

// formatMemory is memory.show's text: one numbered line per entry.
func formatMemory(entries []memory.Entry) string {
	if len(entries) == 0 {
		return "No preferences remembered. Add one with: code-foundry memory add \"<preference>\""
	}
	var b strings.Builder
	for i, e := range entries {
		if i > 0 {
			b.WriteByte('\n')
		}
		fmt.Fprintf(&b, "%d. %s", e.Index, e.Text)
	}
	return b.String()
}

// memoryErr maps the memory store's errors to the command's: a bad entry or reference
// to an argument error on arg, no match to NotFound, a full memory to FailedPrecondition.
func memoryErr(arg string, err error) error {
	switch {
	case connect.CodeOf(err) != connect.CodeUnknown:
		return err
	case errors.Is(err, memory.ErrInvalidArgument) && arg != "":
		return InvalidArg(arg, "%s", strings.TrimPrefix(err.Error(), memory.ErrInvalidArgument.Error()+": "))
	case errors.Is(err, memory.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, memory.ErrFull):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return Failed(err)
}

type noMemory struct{}

var errNoMemory = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no app memory"))

func (noMemory) Entries() ([]memory.Entry, error)    { return nil, errNoMemory }
func (noMemory) Add(string) (memory.Added, error)    { return memory.Added{}, errNoMemory }
func (noMemory) Remove(string) (memory.Entry, error) { return memory.Entry{}, errNoMemory }
func (noMemory) Clear() (int, error)                 { return 0, errNoMemory }
