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
// implements it. by is the thread that asked ("" for the user outside one): Add records
// it with the entry, the others log it.
type MemoryBackend interface {
	Entries() ([]memory.Entry, error)
	Add(text string, by memory.Origin) (memory.Added, error)
	Remove(ref, by string) (memory.Entry, error)
	RemoveID(id, by string) (memory.Entry, error)
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

// MemoryEntryView is an entry in the memory.* commands' JSON: its number, id and text,
// where it came from (docs/notes/memory-dir.md), and whether threads get it. ID is its
// file name without ".md" (`memory remove --id`). Created is RFC 3339 in UTC to the
// millisecond (memory.CreatedLayout), "" when unknown (a file added by hand); ThreadID
// and ThreadName are the thread that added it and its name then, "" when the user did
// (their terminal, the GUI). LeftOut is why threads do not get it (memory.LeftOut*),
// "" when they do.
type MemoryEntryView struct {
	Index      int    `json:"index"`
	ID         string `json:"id"`
	Text       string `json:"text"`
	Created    string `json:"created"`
	ThreadID   string `json:"thread_id"`
	ThreadName string `json:"thread_name"`
	Injected   bool   `json:"injected"`
	LeftOut    string `json:"left_out"`
}

func memoryEntryView(e memory.Entry) MemoryEntryView {
	v := MemoryEntryView{Index: e.Index, ID: e.ID(), Text: e.Text, ThreadID: e.ThreadID, ThreadName: e.ThreadName,
		Injected: e.Injected, LeftOut: e.LeftOut}
	if !e.Created.IsZero() {
		v.Created = e.Created.UTC().Format(memory.CreatedLayout)
	}
	return v
}

// MemoryView is memory.show's JSON.
type MemoryView struct {
	Entries []MemoryEntryView `json:"entries"`
}

// MemoryAddView is memory.add's JSON: the entry, and whether it was added (false: the
// memory had it already).
type MemoryAddView struct {
	Entry MemoryEntryView `json:"entry"`
	Added bool            `json:"added"`
}

// MemoryRemoveView is memory.remove's JSON.
type MemoryRemoveView struct {
	Removed MemoryEntryView `json:"removed"`
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
				views := make([]MemoryEntryView, len(entries))
				for i, e := range entries {
					views[i] = memoryEntryView(e)
				}
				return Result{Message: formatMemory(entries), JSON: MemoryView{Entries: views}}, nil
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
				c, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				added, err := b.Add(a.String("text"), c.origin)
				if err != nil {
					return Result{}, memoryErr("text", err)
				}
				e := added.Entry
				if added.Duplicate {
					return Result{Message: fmt.Sprintf("Already remembered: %q (nothing changed).", e.Text),
						JSON: MemoryAddView{Entry: memoryEntryView(e)}}, nil
				}
				memoryNotify(d.Emitter, c, "Remembered: "+e.Text)
				return Result{Message: fmt.Sprintf("Remembered: %q. %s", e.Text, memoryApplies),
					JSON: MemoryAddView{Entry: memoryEntryView(e), Added: true}}, nil
			},
		},
		Command{
			Name:  "memory.remove",
			Title: "Memory: Forget a Preference",
			Description: "Forget one remembered preference: by its number in `memory show`, its text, its id, or text found in it alone; " +
				"--id names it by id only and fails once it is gone, whatever the list looks like then. " +
				"New threads no longer get it. Refused in a thread another thread started.",
			Category:     "Settings",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "entry", Type: String, Positional: true, Rest: true,
					Description: "The entry's number in memory show, its text, its id, or text that only that entry contains"},
				{Name: "id", Type: String,
					Description: "The entry's id (memory show --json): its file name without .md. Instead of entry"},
			},
			Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
				ref, id := strings.TrimSpace(a.String("entry")), strings.TrimSpace(a.String("id"))
				switch {
				case ref != "" && id != "":
					return Result{}, InvalidArg("id", "give the entry or --id, not both")
				case ref == "" && id == "":
					return Result{}, InvalidArg("entry", "give an entry's number, its text, or --id")
				}
				c, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				var e memory.Entry
				arg := "entry"
				if id != "" {
					arg = "id"
					e, err = b.RemoveID(id, c.origin.ThreadID)
				} else {
					e, err = b.Remove(ref, c.origin.ThreadID)
				}
				if err != nil {
					return Result{}, memoryErr(arg, err)
				}
				memoryNotify(d.Emitter, c, "Forgot: "+e.Text)
				return Result{Message: fmt.Sprintf("Forgot: %q.", e.Text), JSON: MemoryRemoveView{Removed: memoryEntryView(e)}}, nil
			},
		},
		Command{
			Name:         "memory.clear",
			Title:        "Memory: Forget All Preferences",
			Description:  "Forget every remembered preference. New threads get none. Refused in a thread another thread started.",
			Category:     "Settings",
			NoKeybinding: true,
			Confirm:      "Forget every remembered preference? New threads get none.",
			ConfirmLabel: "Forget all",
			Run: func(ctx context.Context, uctx Context, _ Args) (Result, error) {
				c, err := memoryCaller(ctx, d.Threads, uctx)
				if err != nil {
					return Result{}, err
				}
				n, err := b.Clear(c.origin.ThreadID)
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

// memoryCallerInfo is who a memory change comes from: origin is what an added entry
// records (the thread's id and its name now; zero for the user), label the thread's
// name, else its id, for the notification.
type memoryCallerInfo struct {
	origin memory.Origin
	label  string
}

// memoryCaller is the thread a memory change comes from: the CLI's thread
// ($CODE_FOUNDRY_THREAD; ActiveView is empty only there), none for the user's own
// terminal or the GUI. A thread another thread started is refused (PermissionDenied).
// A thread the store no longer has (a stale environment) counts as the user's, with
// its id recorded and no name.
func memoryCaller(ctx context.Context, threads MemoryThreads, uctx Context) (memoryCallerInfo, error) {
	if uctx.ActiveView != "" || uctx.CallerThreadID == "" {
		return memoryCallerInfo{}, nil
	}
	by := uctx.CallerThreadID
	if threads == nil {
		return memoryCallerInfo{origin: memory.Origin{ThreadID: by}, label: by}, nil
	}
	res, err := threads.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: by}))
	if connect.CodeOf(err) == connect.CodeNotFound {
		return memoryCallerInfo{origin: memory.Origin{ThreadID: by}, label: by}, nil
	}
	if err != nil {
		return memoryCallerInfo{}, Failed(fmt.Errorf("look up the calling thread %s: %w", by, err))
	}
	s := res.Msg.GetThread()
	if creator := s.GetCreatedBy(); creator != "" {
		slog.Warn("memory: change refused from a thread another thread started", "thread", by, "created_by", creator)
		return memoryCallerInfo{}, connect.NewError(connect.CodePermissionDenied, fmt.Errorf(
			"%w: thread %s was started by thread %s; tell that thread instead", errMemoryChildThread, by, creator))
	}
	return memoryCallerInfo{origin: memory.Origin{ThreadID: by, ThreadName: s.GetName()}, label: threadNameOrID(s)}, nil
}

// memoryLink is the GUI's Settings › Memory page (UiIntent.Notify.link).
const memoryLink = "settings:memory"

// memoryNotify shows a change a thread made in every window, so a line added to every
// thread's system prompt is never silent; its button opens Settings › Memory. A change
// outside a thread (the user's) shows nothing: the user made it.
func memoryNotify(e Emitter, c memoryCallerInfo, title string) {
	if e == nil || c.origin.ThreadID == "" {
		return
	}
	body := fmt.Sprintf("By thread %q.", c.label)
	e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_Notify_{Notify: &v1.UiIntent_Notify{
		Level: v1.UiIntent_Notify_LEVEL_INFO, Title: clipText(title, 120), Body: body,
		Link: memoryLink, LinkLabel: "Show in Settings",
	}}})
}

// formatMemory is memory.show's text: one numbered line per entry, an entry threads do
// not get marked with why.
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
		if why := leftOutWords(e.LeftOut); why != "" {
			fmt.Fprintf(&b, " [not given to threads: %s]", why)
		}
	}
	return b.String()
}

// leftOutWords says why threads do not get an entry (memory.Entry.LeftOut); "" when
// they do.
func leftOutWords(reason string) string {
	switch reason {
	case memory.LeftOutTooLong:
		return fmt.Sprintf("longer than %d characters; remove it and say it shorter", memory.MaxEntryChars)
	case memory.LeftOutEntries:
		return fmt.Sprintf("past the %d-entry limit", memory.MaxEntries)
	case memory.LeftOutBytes:
		return "past the 4 KiB limit"
	case "":
		return ""
	}
	return reason
}

// memoryErr maps the memory store's errors to the command's: a bad entry or reference
// to an argument error on arg, no match to NotFound, a full memory to the command's own
// failure (FailedPrecondition with CommandFailed: the CLI prints it and exits 1, as for
// any state the caller did not get wrong, not a usage error).
func memoryErr(arg string, err error) error {
	switch {
	case connect.CodeOf(err) != connect.CodeUnknown:
		return err
	case errors.Is(err, memory.ErrInvalidArgument) && arg != "":
		return InvalidArg(arg, "%s", strings.TrimPrefix(err.Error(), memory.ErrInvalidArgument.Error()+": "))
	case errors.Is(err, memory.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, memory.ErrFull):
		return Failed(err)
	}
	return Failed(err)
}

type noMemory struct{}

var errNoMemory = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no app memory"))

func (noMemory) Entries() ([]memory.Entry, error)                { return nil, errNoMemory }
func (noMemory) Add(string, memory.Origin) (memory.Added, error) { return memory.Added{}, errNoMemory }
func (noMemory) Remove(string, string) (memory.Entry, error)     { return memory.Entry{}, errNoMemory }
func (noMemory) RemoveID(string, string) (memory.Entry, error)   { return memory.Entry{}, errNoMemory }
func (noMemory) Clear(string) (int, error)                       { return 0, errNoMemory }
