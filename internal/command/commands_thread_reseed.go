package command

import (
	"context"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.reseed (docs/notes/ember-1-primitives.md): give a thread a fresh Claude session
// with a seed (a system prompt append, add-dirs, a prefix for its first message), the
// primitive behind the resident agent's epochs. An agent and daemon verb: the GUI's
// palette does not list it (gui keys/bindings.ts paletteHidden). Also the resident
// marks of thread.list and thread.get's session line.

// ReseedBackend is the slice of ThreadService thread.reseed needs.
type ReseedBackend interface {
	Reseed(context.Context, *connect.Request[v1.ReseedThreadRequest]) (*connect.Response[v1.ReseedThreadResponse], error)
}

func threadReseedCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.reseed",
		Title: "Reseed Thread",
		Description: "Start a thread's next Claude session afresh (no resume) with a seed: a system prompt append and add-dirs " +
			"for every spawn from now on (what is not given is cleared) and a prefix for the new session's first message. " +
			"The items stay; the epoch goes up. A working thread stops when its turn ends; an idle one at once.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			idArg,
			{Name: "system-prompt", Type: String, FileOrStdin: true, Description: "Appended to Claude's system prompt, at most 64 KiB (@file: from a file, -: stdin)"},
			{Name: "add-dir", Type: String, Repeatable: true, Description: "A directory Claude may read (--add-dir), absolute or ~/…"},
			{Name: "prefix", Type: String, FileOrStdin: true, Description: "Put before the first message of the new session, at most 256 KiB (@file: from a file, -: stdin)"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			var dirs []string
			for line := range strings.SplitSeq(a.String("add-dir"), "\n") {
				if line = strings.TrimSpace(line); line == "" {
					continue
				}
				d, err := ExpandPath(line)
				if err != nil {
					return Result{}, InvalidArg("add-dir", "%v", err)
				}
				dirs = append(dirs, d)
			}
			res, err := b.Reseed(ctx, connect.NewRequest(&v1.ReseedThreadRequest{
				Id: a.String("id"), SystemPromptAppend: a.String("system-prompt"), AddDirs: dirs, Prefix: a.String("prefix"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := "reseeded thread " + threadLabel(s) + " (epoch " + strconv.Itoa(int(s.GetEpoch())) + "); "
			switch {
			case s.GetReseedPending():
				msg += "Claude stops when its turn ends; the next message starts the new session"
			case res.Msg.GetStopped():
				msg += "stopped Claude; the next message starts the new session"
			default:
				msg += "the next message starts the new session"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

// residentMark is thread.list's mark of a resident thread: "resident ember"; "" for
// another.
func residentMark(s *v1.Thread) string {
	if s.GetKind() != v1.ThreadKind_THREAD_KIND_RESIDENT {
		return ""
	}
	return "resident " + s.GetResidentName()
}

// sessionLine is thread.get's line about the thread's session: its resident name, its
// epoch (shown for a resident or after a reseed), its context size and a waiting
// reseed or seed; "" when it has nothing to say.
func sessionLine(s *v1.Thread) string {
	var parts []string
	if m := residentMark(s); m != "" {
		parts = append(parts, m)
	}
	if s.GetKind() == v1.ThreadKind_THREAD_KIND_RESIDENT || s.GetEpoch() > 1 {
		parts = append(parts, "epoch "+strconv.Itoa(int(s.GetEpoch())))
	}
	if n := s.GetContextTokens(); n > 0 {
		parts = append(parts, "context "+formatTokens(n)+" tokens")
	}
	if s.GetReseedPending() {
		parts = append(parts, "reseed pending (Claude stops when its turn ends)")
	}
	if s.GetSeedPending() {
		parts = append(parts, "seed prefix waiting for the next message")
	}
	if len(parts) == 0 {
		return ""
	}
	return "session: " + strings.Join(parts, ", ")
}
