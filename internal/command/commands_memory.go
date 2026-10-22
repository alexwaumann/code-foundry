package command

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

// MemoryBackend is the app memory the memory.* commands read and write: the user's
// standing preferences, which every thread's system prompt carries from its start, and
// a resumed thread gets with its next message after a restart
// (docs/notes/control-3-app-memory.md, control-6-memory-fixes.md). *memory.Store
// implements it. by is the thread that asked ("" for the user outside one), for the log.
type MemoryBackend interface {
	Entries() ([]memory.Entry, error)
	Add(text, by string) (memory.Added, error)
	Remove(ref, by string) (memory.Entry, error)
	Clear(by string) (int, error)
}

var _ MemoryBackend = (*memory.Store)(nil)

// MemoryThreads looks up the thread a memory change comes from (ThreadBackend has it).
type MemoryThreads interface {
	Get(context.Context, *connect.Request[v1.GetThreadRequest]) (*connect.Response[v1.GetThreadResponse], error)
}

// MemoryDeps are what the memory.* commands use. A nil Memory registers them failing
// with Unimplemented. Without Threads a change from a thread is not checked or named;
// without Emitter no notification is shown.
type MemoryDeps struct {
	Memory  MemoryBackend
	Threads MemoryThreads
	Emitter Emitter
}

// memoryApplies follows an added entry: claude records the system prompt on a
// conversation's first request, so a thread already open gets the change as a note on
// its next message after a restart (thread store, memory.go).
const memoryApplies = "New threads will follow it; threads already open get it on their next message after a restart."

// errMemoryChildThread refuses a change from a thread another thread started: a worker
// would otherwise add a line to every thread's system prompt without the user seeing.
var errMemoryChildThread = errors.New("memory is written from the user's own threads only")

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

// RegisterMemory registers memory.show, memory.add, memory.remove and memory.clear.
func RegisterMemory(r *Registry, d MemoryDeps) error {
	b := d.Memory
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
				"in the user's words. New threads follow it; threads already open get it with their next message after a restart. " +
				"At most 500 characters, 40 entries and 4 KiB in all; text the memory has already is not added again. " +
				"Refused in a thread another thread started.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{{Name: "text", Type: String, Required: true, Positional: true, Rest: true,
				Description: "The preference, one line (several words need no quotes)"}},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				by, name, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				added, err := b.Add(a.String("text"), by)
				if err != nil {
					return Result{}, memoryErr("text", err)
				}
				e := added.Entry
				if added.Duplicate {
					return Result{Message: fmt.Sprintf("Already remembered: %q (nothing changed).", e.Text),
						JSON: MemoryAddView{Entry: e}}, nil
				}
				memoryNotify(d.Emitter, by, name, "Remembered: "+e.Text)
				return Result{Message: fmt.Sprintf("Remembered: %q. %s", e.Text, memoryApplies),
					JSON: MemoryAddView{Entry: e, Added: true}}, nil
			},
		},
		Command{
			Name:  "memory.remove",
			Title: "Memory: Forget a Preference",
			Description: "Forget one remembered preference: by its number in `memory show`, its text, or text found in it alone. " +
				"New threads no longer get it. Refused in a thread another thread started.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{{Name: "entry", Type: String, Required: true, Positional: true, Rest: true,
				Description: "The entry's number in memory show, its text, or text that only that entry contains"}},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				by, name, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				e, err := b.Remove(a.String("entry"), by)
				if err != nil {
					return Result{}, memoryErr("entry", err)
				}
				memoryNotify(d.Emitter, by, name, "Forgot: "+e.Text)
				return Result{Message: fmt.Sprintf("Forgot: %q.", e.Text), JSON: MemoryRemoveView{Removed: e}}, nil
			},
		},
		Command{
			Name:         "memory.clear",
			Title:        "Memory: Forget All Preferences",
			Description:  "Forget every remembered preference. New threads get none. Refused in a thread another thread started.",
			Category:     "Settings",
			NoKeybinding: true,
			Confirm:      "Forget every remembered preference? New threads get none.",
			Run: func(ctx context.Context, uctx Context, _ Args) (Result, error) {
				by, _, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				n, err := b.Clear(by)
				if err != nil {
					return Result{}, memoryErr("", err)
				}
				if n == 0 {
					return Result{Message: "No preferences to forget.", JSON: MemoryClearView{}}, nil
				}
				return Result{Message: fmt.Sprintf("Forgot %s.", plural(n, "preference")), JSON: MemoryClearView{Removed: n}}, nil
			},
		},
	)
}

// memoryCaller is the thread a memory change comes from: the CLI's thread
// ($CODE_FOUNDRY_THREAD; ActiveView is empty only there), "" for the user's own
// terminal or the GUI. A thread another thread started is refused (PermissionDenied).
// name is the thread's name, else its id, for the notification. A thread the store no
// longer has (a stale environment) counts as the user's.
func memoryCaller(ctx context.Context, threads MemoryThreads, uctx Context) (by, name string, err error) {
	if uctx.ActiveView != "" || uctx.CallerThreadID == "" {
		return "", "", nil
	}
	by = uctx.CallerThreadID
	if threads == nil {
		return by, by, nil
	}
	res, err := threads.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: by}))
	if connect.CodeOf(err) == connect.CodeNotFound {
		return by, by, nil
	}
	if err != nil {
		return "", "", Failed(fmt.Errorf("look up the calling thread %s: %w", by, err))
	}
	s := res.Msg.GetThread()
	if creator := s.GetCreatedBy(); creator != "" {
		slog.Warn("memory: change refused from a thread another thread started", "thread", by, "created_by", creator)
		return "", "", connect.NewError(connect.CodePermissionDenied, fmt.Errorf(
			"%w: thread %s was started by thread %s; tell that thread instead", errMemoryChildThread, by, creator))
	}
	return by, threadNameOrID(s), nil
}

// memoryNotify shows a change a thread made in every window, so a line added to every
// thread's system prompt is never silent. A change outside a thread (the user's) shows
// nothing: the user made it.
func memoryNotify(e Emitter, by, name, title string) {
	if e == nil || by == "" {
		return
	}
	body := fmt.Sprintf("By thread %q.", name)
	e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
		Level: v1.UiIntent_Notify_LEVEL_INFO, Title: clipText(title, 120), Body: body,
	}}})
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

func (noMemory) Entries() ([]memory.Entry, error)            { return nil, errNoMemory }
func (noMemory) Add(string, string) (memory.Added, error)    { return memory.Added{}, errNoMemory }
func (noMemory) Remove(string, string) (memory.Entry, error) { return memory.Entry{}, errNoMemory }
func (noMemory) Clear(string) (int, error)                   { return 0, errNoMemory }
