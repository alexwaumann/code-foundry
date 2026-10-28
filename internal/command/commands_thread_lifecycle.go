package command

import (
	"context"
	"fmt"
	"os"
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

// supervisedHelp says what supervised does: Claude's manual mode, which asks before
// edits and commands but runs reads, searches and read-only commands unasked, and the
// protocol verbs every thread has pre-allowed (thread.ProtocolAllowedTools).
const supervisedHelp = "supervised (asks before edits and commands, not read-only ones or thread report(s)/get/list/read, project list)"

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

// projectRefs is splitList for a list of project refs: a path ref's leading ~/ is
// expanded, which a shell does not do after a comma (--projects web,~/src/api). The
// daemon runs as the user, so its home is the CLI's.
func projectRefs(v string) []string {
	refs := splitList(v)
	for i, r := range refs {
		if r == "~" || strings.HasPrefix(r, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				refs[i] = home + r[1:]
			}
		}
	}
	return refs
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
	for _, name := range []string{"project", "worktree", "workspace", "projects", "like", "new-branch", "new-worktree", "base", "base-from-origin", "branch"} {
		if a.String(name) != "" || a.Bool(name) {
			return InvalidArg(name, "no-project starts a thread without a project; it does not take %s", name)
		}
	}
	return nil
}

// createdMessage is the first part of what thread.new and thread.new-like say about the
// thread req made (res): where it runs, its projects, workspace and mode, and what the
// placement did with the primary (docs/notes/workspaces-v2-fix-2-threads.md, finding 7).
// Project ids are named through name.
func createdMessage(req *v1.CreateThreadRequest, res *v1.CreateThreadResponse, name func(string) string) string {
	s := res.GetThread()
	msg := "created thread " + threadLabel(s) + " in " + s.GetWorktreePath()
	if n := len(s.GetProjectIds()); n > 1 {
		msg += fmt.Sprintf(" (%d projects: %s; thread checkouts lists them)", n, strings.Join(mapNames(s.GetProjectIds(), name), ", "))
	}
	if s.GetWorkspaceId() != "" {
		msg += " (workspace " + s.GetWorkspaceId() + ")"
	}
	if req.GetNoProject() || (req.GetLikeThreadId() != "" && len(s.GetProjectIds()) == 0 && s.GetProjectId() == "" && s.GetWorkspaceId() == "") {
		msg += " (no project)" // also a like of a thread without one
	}
	switch {
	case res.GetMadeWorktree() && res.GetMadeBranch() && s.GetBaseRef() != "":
		msg += " (new worktree from " + s.GetBaseRef() + ")"
	case res.GetMadeWorktree():
		msg += " (new worktree on existing branch " + s.GetBranch() + ")"
	case res.GetExistingWorktree() && res.GetSharedWith() != "":
		msg += " (worktree " + s.GetWorktreePath() + ", shared with " + res.GetSharedWith() + ")"
	case res.GetExistingWorktree():
		msg += " (existing worktree)"
	case s.GetCreatedWorktree():
		msg += " (worktrees on " + s.GetBranch() + ")" // the primary is a folder
	}
	if res.GetWorktreeModeDropped() {
		msg += " (no worktrees: none of its projects has git, so it runs in their folders)"
	}
	return msg
}

// threadLabel is "name (id)" or just the id.
func threadLabel(s *v1.Thread) string {
	if s.GetName() != "" {
		return s.GetName() + " (" + s.GetId() + ")"
	}
	return s.GetId()
}

// RegisterThreadLifecycle registers thread.new, thread.focus, thread.rename,
// thread.fork, thread.remove, thread.run-in, thread.pin, thread.archive,
// thread.snooze and thread.sidebar, and the metadata, flags and restart commands. There is no close or reconnect: a message starts a stopped thread and
// the daemon stops idle ones (docs/notes/thread-lifecycle.md). The user-facing word is "thread" (titles, descriptions, messages);
// command names and identifiers keep "thread".
func RegisterThreadLifecycle(r *Registry, b ThreadBackend, e Emitter) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp}
	return r.RegisterAll(
		Command{
			Name:  "thread.new",
			Title: "New Thread",
			Description: "Start Claude Code in a worktree (default: the active worktree, else the active project's main worktree, else where the thread this runs in runs), or in a new worktree. " +
				"Inside a thread it copies that thread's projects, branch and mode. " +
				"With no-project it belongs to no project and runs in your home directory.",
			Category:    "Thread",
			Keybindings: []string{"cmd+n"},
			Args: []ArgSpec{
				{Name: "project", Type: String, Context: ContextProject, Description: "Project id or name it runs in (with projects or like: one of them)"},
				{Name: "worktree", Type: Path, Context: ContextWorktree, Description: "Worktree path (with workspace: a member worktree)"},
				{Name: "workspace", Type: String, Description: "Workspace id or name: its projects (unless projects) and instructions; project workspace runs it in its folder (a project named workspace wins)"},
				{Name: "projects", Type: String, Description: "Comma-separated projects it works in (project:base with new-worktree); it runs in the first unless project"},
				{Name: "like", Type: String, ID: ThreadID, Description: "Thread to copy projects, branch and mode from"},
				{Name: "new-branch", Type: Bool, Description: "With like, or in a thread: a new branch, new worktrees"},
				{Name: "model", Type: Enum, Enum: ThreadModels, Description: threadModelHelp + " (default: settings threads.default_model)"},
				{Name: "effort", Type: Enum, Enum: ThreadEfforts, Description: "Effort level (default: settings threads.default_effort)"},
				{Name: "permission", Type: Enum, Enum: ThreadPermissions, Default: "auto",
					Description: supervisedHelp + ", accept-edits (edits allowed) or auto"},
				{Name: "new-worktree", Type: Bool, Description: "New worktrees on a new branch (named from the prompt by projects.branch_naming, e.g. feat/add-filter, else cf/<thread id>); =false: each project's own checkout"},
				{Name: "base", Type: String, Description: "Ref the new worktree branches from (default: the default branch; a branch name means origin's copy, fetched, unless the local one is ahead or base-from-origin is no); needs new-worktree; ignored when branch exists"},
				baseFromOriginArg,
				{Name: "branch", Type: String, Description: "The new worktree's branch: an existing one is checked out; a new one with a / is used as given, else it is the slug the naming mode wraps (feat/<slug>, <prefix>/<slug>); needs new-worktree"},
				{Name: "name", Type: String, Description: "Thread name (default: generated from the first message)"},
				{Name: "prompt", Type: String, FileOrStdin: true, Description: "The first message (@file: from a file, -: stdin)"},
				{Name: "attachments", Type: String, Description: "Comma-separated image or PDF paths from StageAttachment, appended to the prompt"},
				{Name: "composer-prompt", Type: String, Description: "The GUI's text of prompt with its tag tokens, for display (the GUI sets it)"},
				{Name: "no-project", Type: Bool, Description: "Start the thread without a project, in your home directory (no placement or worktree flags with it)"},
				{Name: "created-by", Type: String, DefaultToThreadEnv: true, ID: ThreadID,
					Description: "Id of the thread whose agent creates this one, noted at the top of the new thread (default: the thread this command runs in, $CODE_FOUNDRY_THREAD; pass an empty value to opt out)"},
				{Name: "brief", Type: String, Description: "What the thread is for, in at most 500 characters (shown with the creator's note)"},
				{Name: "labels", Type: String, Description: "Comma-separated labels (lowercase letters, digits, -, _, . and /)"},
				{Name: "budget", Type: String, Description: "Spending limit in USD at Claude API rates, e.g. 5.00: Claude is interrupted when the thread's cost reaches it"},
				{Name: "notify", Type: Bool, Description: "With created-by: wake the creator with a message each time the new thread settles (a repeat thread.subscribe)"},
				sidebarCreateArg,
				createdFocusArg,
				{Name: "request-id", Type: String, Description: "An idempotency key (at most 128 characters): repeating thread.new with a key its creator used " +
					"in the last 24 hours prints the thread made then and starts nothing"},
			},
			When: canStartThread,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				ws, projects := a.String("workspace"), projectRefs(a.String("projects"))
				unplaced := false
				if a.Bool("no-project") {
					if err := noProjectAlone(a); err != nil {
						return Result{}, err
					}
				} else if a.String("project") == "" && a.Path("worktree") == "" && ws == "" && len(projects) == 0 && a.String("like") == "" {
					unplaced = true
				}
				req := &v1.CreateThreadRequest{
					ProjectId: a.String("project"), WorktreePath: a.Path("worktree"), Model: a.String("model"),
					Effort: a.String("effort"), Name: a.String("name"), InitialPrompt: a.String("prompt"),
					ComposerPrompt: a.String("composer-prompt"), PermissionMode: threadPermissionModes[a.String("permission")], Attachments: splitList(a.String("attachments")),
					WorkspaceId: ws, NoProject: a.Bool("no-project"),
					ProjectIds: projects, LikeThreadId: a.String("like"), NewBranch: a.Bool("new-branch"),
					CreatedBy: a.String("created-by"), Brief: a.String("brief"), Labels: splitList(a.String("labels")),
					Notify: a.Bool("notify"), RequestId: a.String("request-id"),
					// A model or effort from the settings' default, not chosen: a resident's
					// worker defaults may replace it (docs/notes/ember-2-store.md).
					ModelDefaulted:  a.String("model") != "" && !a.Given("model"),
					EffortDefaulted: a.String("effort") != "" && !a.Given("effort"),
				}
				if unplaced {
					// From a thread (its CLI or a page it shows): where that thread runs,
					// unless --created-by= opted out of that thread altogether.
					placed := false
					if !a.Blank("created-by") {
						var err error
						if placed, err = callerPlacement(ctx, b, c, req); err != nil {
							return Result{}, err
						}
					}
					if !placed && a.Blank("created-by") && c.CallerThreadID != "" {
						return Result{}, InvalidArg("created-by", "an empty created-by opts out of the thread this runs in, its placement too; name a project, worktree, workspace or like (or no-project)")
					}
					if !placed {
						return Result{}, InvalidArg("worktree", "a worktree, project, or workspace is required (or no-project)")
					}
					if req.GetNoProject() {
						if err := noProjectAlone(a); err != nil {
							return Result{}, InvalidArg("project", "the thread this runs in has no project, so the new thread has none either; name a project for a worktree or branch")
						}
					}
				}
				if req.Notify && strings.TrimSpace(req.CreatedBy) == "" {
					return Result{}, InvalidArg("notify", "needs created-by (the thread to wake; the CLI defaults it to $CODE_FOUNDRY_THREAD inside a thread)")
				}
				if err := createSidebar(req, a); err != nil {
					return Result{}, err
				}
				if a.Has("budget") {
					usd, err := parseUSD("budget", a.String("budget"))
					if err != nil {
						return Result{}, err
					}
					req.BudgetUsd = usd
				}
				fromOrigin, err := baseFromOrigin(a)
				if err != nil {
					return Result{}, err
				}
				newBranch := a.Bool("new-worktree") || req.NewBranch
				switch {
				case req.NewBranch && a.Given("new-worktree") && !a.Bool("new-worktree"):
					return Result{}, InvalidArg("new-branch", "a new branch is made in new worktrees; it does not go with new-worktree=false")
				case newBranch:
					req.NewWorktree = &v1.NewWorktree{BaseRef: a.String("base"), Branch: a.String("branch"), BaseFromOrigin: fromOrigin}
				case a.String("base") != "":
					return Result{}, InvalidArg("base", "only applies with new-worktree or new-branch")
				case fromOrigin != nil:
					return Result{}, InvalidArg("base-from-origin", "only applies with new-worktree or new-branch")
				case a.String("branch") != "":
					return Result{}, InvalidArg("branch", "only applies with new-worktree or new-branch")
				case a.Given("new-worktree"):
					// --new-worktree=false: each project's own checkout, also when the copied
					// thread (like, or the creating one) works in worktrees.
					req.CheckoutMode = true
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
				focusCreated(e, a, s.GetId())
				msg := createdMessage(req, res.Msg, r.projectNamer(ctx))
				if req.GetNotify() {
					msg += "; " + req.GetCreatedBy() + " is woken each time it settles"
				}
				if req.InSidebar != nil {
					msg += "; " + map[bool]string{true: "shown in", false: "hidden from"}[req.GetInSidebar()] + " the sidebar"
				}
				// Collision hints, never a refusal: printed on stderr.
				return Result{Message: msg, JSON: s, Warnings: res.Msg.GetHints()}, nil
			},
		},
		threadNewLike(r, b, e),
		Command{
			Name:         "thread.focus",
			NoPalette:    true,
			Title:        "Focus Thread",
			Description:  "Show a thread in every connected window.",
			Category:     "Thread",
			NoKeybinding: true,
			Args:         []ArgSpec{idArg},
			When:         hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if err := r.known(ctx, ThreadID, a.String("id")); err != nil {
					return Result{}, err
				}
				return EmitTo(e, &v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: a.String("id")}}}).Result(), nil
			},
		},
		Command{
			Name:        "thread.rename",
			Title:       "Rename Thread",
			Description: "Set the thread's name. Turns off automatic naming.",
			Category:    "Thread",
			Keybindings: []string{"cmd+r"},
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Required: true, Positional: true, Description: "New name"}},
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
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Description: "Name for the fork"}, createdFocusArg},
			When:        hasThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Fork(ctx, connect.NewRequest(&v1.ForkThreadRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetThread()
				focusCreated(e, a, s.GetId())
				return Result{Message: "forked " + a.String("id") + " into " + threadLabel(s), JSON: s}, nil
			},
		},
		Command{
			Name:        "thread.remove",
			Title:       "Remove Thread",
			Description: "Forget a thread, stopping Claude first if it runs.",
			Category:    "Thread",
			Args:        []ArgSpec{positional(optionalID(idArg)), threadIDsArg},
			When:        hasThreadOrCLI,
			Confirm:     "Remove thread {id}? Claude stops if it runs, and the thread is forgotten.",
			// Without a thread Run says what is missing; with ids the message counts them.
			ConfirmIf: func(_ context.Context, c Context, a Args) bool {
				_, err := targetThreads(a)
				return err == nil && notSelf(c, a, "removing") == nil
			},
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string { return removeConfirm(ctx, b, a) },
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				if err := notSelf(c, a, "removing"); err != nil {
					return Result{}, err
				}
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
		threadCheckouts(b),
		threadPrompts(b),
		threadPin(b, idArg),
		threadArchive(b, idArg),
		threadSnooze(b, idArg),
		threadGet(b, idArg),
		threadLabelCmd(b, idArg),
		threadReportCmd(b, idArg),
		threadBudgetCmd(b, idArg),
		threadFlagsCmd(b, idArg),
		threadFlagClearCmd(b, idArg),
		threadRestartCmd(b, idArg),
		threadSidebarCmd(b, idArg),
		threadWorkspaceCmd(b, idArg),
		threadReseedCmd(b, idArg),
	)
}
