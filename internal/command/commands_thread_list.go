package command

import (
	"cmp"
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.list (docs/notes/agents-5-cli.md): the daemon filters (ThreadFilter), so an
// agent with hundreds of archived threads reads the few it asks for. Text output is one
// compact line per thread; --json the ListThreadsResponse (the retired usage ledger
// only with --all).

// ThreadListStatuses are thread.list's status values (ThreadStatus).
var ThreadListStatuses = []string{"busy", "idle", "attention", "error"}

var threadListStatuses = map[string]v1.ThreadStatus{
	"busy":      v1.ThreadStatus_THREAD_STATUS_BUSY,
	"idle":      v1.ThreadStatus_THREAD_STATUS_IDLE,
	"attention": v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION,
	"error":     v1.ThreadStatus_THREAD_STATUS_ERROR,
}

// ThreadListStates are thread.list's state values (ThreadState).
var ThreadListStates = []string{"starting", "connected", "closing", "disconnected"}

// threadListDefaultLimit is thread.list's limit default.
const threadListDefaultLimit = "50"

// ThreadListDeps are thread.list's dependencies: the threads, and the projects for
// their names and branches.
type ThreadListDeps struct {
	Thread ThreadBackend
	Repo   RepoBackend
}

// RegisterThreadList registers thread.list.
func RegisterThreadList(r *Registry, d ThreadListDeps) error {
	return r.Register(Command{
		Name:  "thread.list",
		Title: "List Threads",
		Description: "List threads, the most recently active first: one line each, " +
			"`<id>  <status>  <name>  <project>@<branch>  <age>` and `↳ <creator>` for a thread another thread created. " +
			"Archived threads are left out unless archived or all is given; at most limit threads.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "archived", Type: Bool, Description: "Include archived threads"},
			{Name: "all", Type: Bool, Description: "Every thread, archived ones too, ignoring the other filters except limit (--json: also the usage of removed threads)"},
			{Name: "status", Type: Enum, Enum: ThreadListStatuses, Description: "Only threads with this status: busy, idle, attention (a prompt, a question or a finished turn), or error"},
			{Name: "state", Type: Enum, Enum: ThreadListStates, Description: "Only threads whose Claude process is starting, connected, closing, or disconnected"},
			{Name: "repo", Type: String, Description: "Only threads in this project: its id, name, or an absolute path inside it"},
			{Name: "workspace", Type: String, Description: "Only threads of this workspace: its id or name"},
			{Name: "created-by", Type: String, Description: "Only threads this thread created (its id, or a unique suffix of 4+ characters), or user for threads no thread created"},
			{Name: "label", Type: String, Description: "Comma-separated labels: only threads carrying all of them"},
			{Name: "limit", Type: Int, Default: threadListDefaultLimit, Description: "At most this many threads, the most recently active (0: no limit)"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.Int("limit") < 0 {
				return Result{}, InvalidArg("limit", "limit must be 0 (no limit) or more, not %d", a.Int("limit"))
			}
			f := &v1.ThreadFilter{
				All: a.Bool("all"), IncludeArchived: a.Bool("archived"),
				Status: threadListStatuses[a.String("status")], State: threadListState(a.String("state")),
				Repo: strings.TrimSpace(a.String("repo")), Workspace: strings.TrimSpace(a.String("workspace")),
				Labels: splitList(a.String("label")), Limit: int32(a.Int("limit")),
			}
			if by := strings.TrimSpace(a.String("created-by")); by != "" && by != "user" {
				ids, err := threadIDs(d.Thread)(ctx)
				if err != nil {
					return Result{}, err
				}
				if f.CreatedBy, err = ResolveID(ThreadID, "created-by", by, ids); err != nil {
					return Result{}, err
				}
			} else {
				f.CreatedBy = by
			}
			res, err := d.Thread.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: f}))
			if err != nil {
				return Result{}, err
			}
			repos, err := d.Repo.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: formatThreadList(res.Msg.GetThreads(), repos.Msg.GetRepos(), f, time.Now()), JSON: res.Msg}, nil
		},
	})
}

func threadListState(s string) v1.ThreadState {
	if s == "" {
		return v1.ThreadState_THREAD_STATE_UNSPECIFIED
	}
	return v1.ThreadState(v1.ThreadState_value["THREAD_STATE_"+strings.ToUpper(s)])
}

// formatThreadList is thread.list's text: one aligned line per thread, then a hint when
// the limit cut the list, or why it is empty.
func formatThreadList(threads []*v1.Thread, repos []*v1.Repo, f *v1.ThreadFilter, now time.Time) string {
	if len(threads) == 0 {
		if !f.GetAll() && !f.GetIncludeArchived() {
			return "no threads (archived threads are left out; --archived includes them)"
		}
		return "no threads"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	for _, s := range threads {
		line := fmt.Sprintf("%s\t%s\t%s\t%s\t%s", s.GetId(), threadStatusWord(s), threadDisplayName(s), threadPlace(s, repos), age(lastActivity(s), now))
		var marks []string
		if s.GetArchivedAt() != nil {
			marks = append(marks, "archived")
		}
		if s.GetSnoozedUntil() != nil {
			marks = append(marks, "snoozed")
		}
		if len(marks) > 0 {
			line += "  [" + strings.Join(marks, ", ") + "]"
		}
		if s.GetCreatedBy() != "" {
			line += "  ↳ " + cmp.Or(s.GetCreatedByName(), s.GetCreatedBy())
		}
		_, _ = fmt.Fprintln(tw, line)
	}
	_ = tw.Flush()
	out := strings.TrimRight(sb.String(), "\n")
	if n := f.GetLimit(); n > 0 && len(threads) == int(n) {
		out += fmt.Sprintf("\n(the %d most recently active; --limit 0 lists all)", n)
	}
	return out
}

// threadStatusWord is a thread's status as thread.list's --status names it, with the
// reason for attention and error: "busy", "attention (finished)", "error (interrupted)".
func threadStatusWord(s *v1.Thread) string {
	var w string
	switch s.GetStatus() {
	case v1.ThreadStatus_THREAD_STATUS_BUSY:
		return "busy"
	case v1.ThreadStatus_THREAD_STATUS_IDLE:
		return "idle"
	case v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION:
		w = "attention"
	case v1.ThreadStatus_THREAD_STATUS_ERROR:
		w = "error"
	default:
		return "unknown"
	}
	if r := s.GetStatusReason(); r != "" {
		w += " (" + r + ")"
	}
	return w
}

// threadDisplayName is the name, or "(unnamed)".
func threadDisplayName(s *v1.Thread) string {
	if s.GetName() != "" {
		return s.GetName()
	}
	return "(unnamed)"
}

// threadPlace is "<project>@<branch>" for a thread's cwd ("<project>" alone when the
// branch is unknown), "no project" for a thread without one.
func threadPlace(s *v1.Thread, repos []*v1.Repo) string {
	if s.GetRepoId() == "" && s.GetWorkspaceId() == "" {
		return "no project"
	}
	for _, r := range repos {
		if r.GetId() != s.GetRepoId() {
			continue
		}
		for _, w := range r.GetWorktrees() {
			if filepath.Clean(w.GetPath()) == filepath.Clean(s.GetWorktreePath()) && w.GetBranch() != "" {
				return r.GetName() + "@" + w.GetBranch()
			}
		}
		return r.GetName()
	}
	return cmp.Or(s.GetRepoId(), filepath.Base(s.GetWorktreePath()))
}

// lastActivity is when the thread last did something (else when it was created).
func lastActivity(s *v1.Thread) time.Time {
	if t := s.GetLastActivityAt(); t != nil {
		return t.AsTime()
	}
	return s.GetCreatedAt().AsTime()
}

// age is how long ago t was, in one unit: "now", "42s", "5m", "3h", "2d".
func age(t, now time.Time) string {
	if t.IsZero() || t.Unix() <= 0 {
		return "-"
	}
	d := now.Sub(t)
	switch {
	case d < time.Second:
		return "now"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d/time.Second))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d/time.Minute))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d/time.Hour))
	default:
		return fmt.Sprintf("%dd", int(d/(24*time.Hour)))
	}
}
