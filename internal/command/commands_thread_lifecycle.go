package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/model"
)

// Models and effort levels offered for new threads. Models come from the registry
// (internal/model): pinned ids with the 1M suffix ("claude-opus-4-8[1m]"). From
// `claude --help` (Claude Code 2.1.294): --effort takes low, medium, high, xhigh, max.
// The ThreadService API also accepts full model names outside the registry.
var (
	ThreadModels  = model.Values()
	ThreadEfforts = []string{"low", "medium", "high", "xhigh", "max"}
)

// threadModelHelp describes the model arg; the enum values list the registry.
const threadModelHelp = "Model: a claude-* id with the 1M context suffix; quote it in the shell ('claude-opus-4-8[1m]')"

// ThreadPermissions are thread.new's permission values, mapped to the claude
// --permission-mode they select by threadPermissionModes. Full access
// (bypassPermissions) is deliberately not offered.
var ThreadPermissions = []string{"supervised", "accept-edits", "auto"}

var threadPermissionModes = map[string]v1.PermissionMode{
	"supervised":   v1.PermissionMode_PERMISSION_MODE_SUPERVISED,
	"accept-edits": v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS,
	"auto":         v1.PermissionMode_PERMISSION_MODE_AUTO,
}

// splitList splits a comma-separated arg, dropping blanks.
func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func hasThread(c Context) bool { return c.ActiveThreadID != "" }

func hasProjectOrWorktree(c Context) bool {
	return c.ActiveProjectID != "" || c.ActiveWorktreePath != ""
}

// canStartThread is thread.new's availability: a GUI caller needs an active
// repository or worktree, or the composer (whose target may be no project at all). A
// CLI caller (no active view) names everything with flags, and --workspace, --projects or
// --no-project alone are enough, which When cannot see, so Run validates instead.
func canStartThread(c Context) bool {
	return hasProjectOrWorktree(c) || c.ActiveView == "" || c.ActiveView == "compose"
}

// noProjectAlone refuses thread.new's no-project with any arg that places the thread
// in a project or workspace.
func noProjectAlone(a Args) error {
	for _, name := range []string{"project", "worktree", "workspace", "projects", "new-worktree", "base"} {
		if a.String(name) != "" || a.Bool(name) {
			return InvalidArg(name, "no-project starts a thread without a project; it does not take %s", name)
		}
	}
	return nil
}

// threadLabel is "name (id)" or just the id.
func threadLabel(s *v1.Thread) string {
	if s.GetName() != "" {
		return s.GetName() + " (" + s.GetId() + ")"
	}
	return s.GetId()
}

// RegisterThreadLifecycle registers thread.new, thread.focus, thread.rename,
// thread.fork, thread.remove, thread.run-in, thread.pin, thread.archive, and
// thread.snooze. There is no close or reconnect: a message starts a stopped thread and
// the daemon stops idle ones (docs/notes/thread-lifecycle.md). The user-facing word is "thread" (titles, descriptions, messages);
// command names and identifiers keep "thread".
func RegisterThreadLifecycle(r *Registry, b ThreadBackend, e Emitter) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp}
	focus := func(id string) int {
		return e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id}}})
	}
	return r.RegisterAll(
		Command{
			Name:  "thread.new",
			Title: "New Thread",
			Description: "Start Claude Code in a worktree (default: the active worktree, else the active project's main worktree), or in a new worktree. " +
				"With workspace the thread belongs to that workspace and runs in one of its member worktrees; with new-worktree and projects it gets a new workspace. " +
				"With no-project it belongs to no project and runs in your home directory.",
			Category:    "Thread",
			Keybindings: []string{"cmd+n"},
			Args: []ArgSpec{
				{Name: "project", Type: String, Context: ContextProject, Description: "Project id or name (with workspace or projects: the member the thread runs in)"},
				{Name: "worktree", Type: Path, Context: ContextWorktree, Description: "Worktree path (with workspace: a member worktree)"},
				{Name: "workspace", Type: String, Description: "Workspace id or name the thread belongs to; it runs in the member project or worktree names (default: the first member)"},
				{Name: "projects", Type: String, Description: "With new-worktree: comma-separated projects (id, name, or path; project:base gives that one its own base) for a new workspace, a cf/<slug of the thread name> worktree in each; project picks the member the thread runs in (default: the first)"},
				{Name: "model", Type: Enum, Enum: ThreadModels, Description: threadModelHelp + " (default: settings threads.default_model)"},
				{Name: "effort", Type: Enum, Enum: ThreadEfforts, Description: "Effort level (default: settings threads.default_effort)"},
				{Name: "permission", Type: Enum, Enum: ThreadPermissions, Default: "auto",
					Description: "Permissions: supervised (confirm every tool call), accept-edits (file edits allowed), or auto (Claude's auto mode)"},
				{Name: "new-worktree", Type: Bool, Description: "Create a new worktree for the thread (branch cf/<slug of the thread name>, named from the prompt); without it the thread works in the given worktree, else the project's own checkout (the GUI's threads.default_worktree does not apply)"},
				{Name: "base", Type: String, Description: "Ref the new worktree branches from (default: origin/<default branch>); needs new-worktree"},
				{Name: "name", Type: String, Description: "Thread name (default: generated from the first message)"},
				{Name: "prompt", Type: String, Description: "First prompt, sent as the thread's first message once Claude is up"},
				{Name: "attachments", Type: String, Description: "Comma-separated image or PDF paths from StageAttachment, appended to the prompt"},
				{Name: "composer-prompt", Type: String, Description: "The GUI composer's text of prompt with its tag tokens, kept on the first message for display (the GUI sets it)"},
				{Name: "no-project", Type: Bool, Description: "Start the thread without a project, in your home directory (not with project, worktree, workspace, projects, new-worktree or base)"},
				{Name: "created-by", Type: String, DefaultToThreadEnv: true, ID: ThreadID,
					Description: "Id of the thread whose agent creates this one, noted at the top of the new thread (default: the thread this command runs in, $CODE_FOUNDRY_THREAD; pass an empty value to opt out)"},
				{Name: "brief", Type: String, Description: "What the thread is for, in at most 500 characters (shown with the creator's note)"},
				{Name: "labels", Type: String, Description: "Comma-separated labels (lowercase letters, digits, -, _, . and /)"},
				{Name: "budget", Type: String, Description: "Spending limit in USD at Claude API rates, e.g. 5.00: Claude is interrupted when the thread's cost reaches it"},
				{Name: "notify", Type: Bool, Description: "With created-by: wake the creator with a message each time the new thread settles (a repeat thread.subscribe)"},
				{Name: "request-id", Type: String, Description: "An idempotency key (at most 128 characters): repeating thread.new with a key its creator used " +
					"in the last 24 hours prints the thread made then and starts nothing"},
			},
			When: canStartThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ws, projects := a.String("workspace"), splitList(a.String("projects"))
				if a.Bool("no-project") {
					if err := noProjectAlone(a); err != nil {
						return Result{}, err
					}
				} else if a.String("project") == "" && a.Path("worktree") == "" && ws == "" && len(projects) == 0 {
					return Result{}, InvalidArg("worktree", "a worktree, project, or workspace is required (or no-project)")
				}
				req := &v1.CreateThreadRequest{
					ProjectId: a.String("project"), WorktreePath: a.Path("worktree"), Model: a.String("model"),
					Effort: a.String("effort"), Name: a.String("name"), InitialPrompt: a.String("prompt"),
					ComposerPrompt: a.String("composer-prompt"), PermissionMode: threadPermissionModes[a.String("permission")], Attachments: splitList(a.String("attachments")),
					WorkspaceId: ws, NoProject: a.Bool("no-project"),
					CreatedBy: a.String("created-by"), Brief: a.String("brief"), Labels: splitList(a.String("labels")),
					Notify: a.Bool("notify"), RequestId: a.String("request-id"),
				}
				if req.Notify && strings.TrimSpace(req.CreatedBy) == "" {
					return Result{}, InvalidArg("notify", "needs created-by (the thread to wake; the CLI defaults it to $CODE_FOUNDRY_THREAD inside a thread)")
				}
				if a.Has("budget") {
					usd, err := parseUSD("budget", a.String("budget"))
					if err != nil {
						return Result{}, err
					}
					req.BudgetUsd = usd
				}
				switch {
				case len(projects) > 0 && !a.Bool("new-worktree"):
					return Result{}, InvalidArg("projects", "only applies with new-worktree (a new workspace); for an existing one use workspace")
				case ws != "" && a.Bool("new-worktree"):
					return Result{}, InvalidArg("workspace", "a workspace thread runs in an existing member; for a new workspace use new-worktree with projects")
				case len(projects) > 0:
					req.NewWorkspace = &v1.NewWorkspace{Projects: projects, BaseRef: a.String("base")}
				case a.Bool("new-worktree"):
					req.NewWorktree = &v1.NewWorktree{BaseRef: a.String("base")}
				case a.String("base") != "":
					return Result{}, InvalidArg("base", "only applies with new-worktree")
				}
				res, err := b.Create(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				if res.Msg.GetReused() {
					// The JSON is the thread, as the first time.
					return Result{Message: "thread " + threadLabel(s) + " in " + s.GetWorktreePath() +
						" was created earlier for request id " + req.GetRequestId() + "; nothing new started", JSON: s}, nil
				}
				focus(s.GetId())
				msg := "created thread " + threadLabel(s) + " in " + s.GetWorktreePath()
				if s.GetWorkspaceId() != "" {
					msg += " (workspace " + s.GetWorkspaceId() + ")"
				}
				if req.GetNoProject() {
					msg += " (no project)"
				}
				if s.GetCreatedWorktree() {
					msg += " (new worktree from " + s.GetBaseRef() + ")"
				}
				if req.GetNotify() {
					msg += "; " + req.GetCreatedBy() + " is woken each time it settles"
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
		Command{
			Name:         "thread.focus",
			Title:        "Focus Thread",
			Description:  "Show a thread in every connected window.",
			Category:     "Thread",
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			When:         hasThread,
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				n := focus(a.String("id"))
				return Result{Message: fmt.Sprintf("delivered=%d", n), JSON: EmitResult{Delivered: n}}, nil
			},
		},
		Command{
			Name:        "thread.rename",
			Title:       "Rename Thread",
			Description: "Set the thread's name. Turns off automatic naming.",
			Category:    "Thread",
			Keybindings: []string{"cmd+r"},
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Required: true, Description: "New name"}},
			When:        hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Rename(ctx, connect.NewRequest(&v1.RenameThreadRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "renamed thread " + threadLabel(res.Msg.GetThread()), JSON: res.Msg.GetThread()}, nil
			},
		},
		Command{
			Name:        "thread.fork",
			Title:       "Fork Thread",
			Description: "Start a new thread that continues this thread's conversation.",
			Category:    "Thread",
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Description: "Name for the fork"}},
			When:        hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Fork(ctx, connect.NewRequest(&v1.ForkThreadRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				focus(s.GetId())
				return Result{Message: "forked " + a.String("id") + " into " + threadLabel(s), JSON: s}, nil
			},
		},
		Command{
			Name:        "thread.remove",
			Title:       "Remove Thread",
			Description: "Forget a thread, stopping Claude first if it runs.",
			Category:    "Thread",
			Args:        []ArgSpec{optionalID(idArg), threadIDsArg},
			When:        hasThreadOrCLI,
			Confirm:     "Remove thread {id}? Claude stops if it runs, and the thread is forgotten.",
			// Without a thread Run says what is missing; with ids the message counts them.
			ConfirmIf: func(_ context.Context, _ Context, a Args) bool {
				_, err := targetThreads(a)
				return err == nil
			},
			DynamicConfirm: func(_ context.Context, _ Context, a Args) string { return removeConfirm(a) },
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ids, err := targetThreads(a)
				if err != nil {
					return Result{}, err
				}
				if a.Has("ids") {
					return removeThreads(ctx, b, ids), nil
				}
				id := ids[0]
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveThreadRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed thread " + id}, nil
			},
		},
		threadRunIn(b, idArg),
		threadPin(b, idArg),
		threadArchive(b, idArg),
		threadSnooze(b, idArg),
		threadGet(b, idArg),
		threadLabelCmd(b, idArg),
		threadReportCmd(b, idArg),
		threadBudgetCmd(b, idArg),
	)
}
