package command

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ActionBackend is the slice of ActionService the action.* commands need, in generated
// Connect signatures (see TerminalBackend for why).
type ActionBackend interface {
	List(context.Context, *connect.Request[v1.ListActionsRequest]) (*connect.Response[v1.ListActionsResponse], error)
	Create(context.Context, *connect.Request[v1.CreateActionRequest]) (*connect.Response[v1.CreateActionResponse], error)
	Update(context.Context, *connect.Request[v1.UpdateActionRequest]) (*connect.Response[v1.UpdateActionResponse], error)
	Delete(context.Context, *connect.Request[v1.DeleteActionRequest]) (*connect.Response[v1.DeleteActionResponse], error)
	Run(context.Context, *connect.Request[v1.RunActionRequest]) (*connect.Response[v1.RunActionResponse], error)
	WaitRun(context.Context, *connect.Request[v1.WaitActionRunRequest]) (*connect.Response[v1.WaitActionRunResponse], error)
}

var (
	_ ActionBackend = codefoundryv1connect.ActionServiceHandler(nil)
	_ ActionBackend = codefoundryv1connect.ActionServiceClient(nil)
)

// ActionDeps are the action.* commands' dependencies. Repo and Session find the
// project and the owner of a run the way terminal.new finds a shell's.
type ActionDeps struct {
	Action ActionBackend
	Repo   RepoBackend
	Thread ThreadBackend
}

// actionIcons maps the icon names the commands take to the proto enum; the first is
// the default.
var actionIcons = []struct {
	name string
	icon v1.ActionIcon
}{
	{"play", v1.ActionIcon_ACTION_ICON_PLAY},
	{"test", v1.ActionIcon_ACTION_ICON_TEST},
	{"lint", v1.ActionIcon_ACTION_ICON_LINT},
	{"configure", v1.ActionIcon_ACTION_ICON_CONFIGURE},
	{"build", v1.ActionIcon_ACTION_ICON_BUILD},
	{"debug", v1.ActionIcon_ACTION_ICON_DEBUG},
}

func actionIconNames() []string {
	out := make([]string, len(actionIcons))
	for i, x := range actionIcons {
		out[i] = x.name
	}
	return out
}

func actionIcon(name string) v1.ActionIcon {
	for _, x := range actionIcons {
		if x.name == name {
			return x.icon
		}
	}
	return v1.ActionIcon_ACTION_ICON_UNSPECIFIED
}

func actionIconName(i v1.ActionIcon) string {
	for _, x := range actionIcons {
		if x.icon == i {
			return x.name
		}
	}
	return "play"
}

// canUseActions: a thread, a project or worktree in context, or the CLI (which finds
// the project from its working directory).
func canUseActions(c Context) bool {
	return hasThread(c) || hasRepoOrWorktree(c) || c.ActiveView == ""
}

// noProject is how the action commands refuse a context without a project.
const noProject = "actions belong to a project: pass --repo, select a thread or a worktree, or run inside a registered project"

// RegisterAction registers action.list, action.add, action.edit, action.remove,
// action.run, action.wait and action.runs.
func RegisterAction(r *Registry, d ActionDeps) error {
	repoArg := ArgSpec{Name: "repo", Type: String, Context: ContextRepo,
		Description: "Project: id, name, or a path inside it (default: the thread's, the worktree's, or the working directory's)"}
	hereArg := ArgSpec{Name: "here", Type: Path, DefaultToCwd: true,
		Description: "Where the CLI runs: without a thread, worktree or --repo, its project is used (CLI default: the working directory)"}
	refArg := ArgSpec{Name: "action", Type: String, Required: true, Positional: true, Description: "Action name (ignoring case) or id"}
	iconArg := ArgSpec{Name: "icon", Type: Enum, Enum: actionIconNames(), Description: "Icon"}
	whyNoProject := func(Context) string { return noProject }
	return r.RegisterAll(
		Command{
			Name:  "action.list",
			Title: "List Actions",
			Description: "List a project's actions: the commands `action run` starts, in order, with their ids. " +
				"The project is the thread's, else the worktree's, else the working directory's.",
			Category:       "Action",
			Args:           []ArgSpec{repoArg, hereArg},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				repoID, err := actionRepo(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.List(ctx, connect.NewRequest(&v1.ListActionsRequest{RepoId: repoID}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatActions(res.Msg.GetActions()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "action.add",
			Title: "Add Action",
			Description: "Add an action to a project: a command line run as `$SHELL -lc <command>` in a worktree, with " +
				"CODE_FOUNDRY_PROJECT_ROOT and CODE_FOUNDRY_WORKTREE set. It opens as a terminal in the bottom panel, " +
				"or with --in-terminal=false runs in the background with its output captured.",
			Category: "Action",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "Name, unique in the project (ignoring case)"},
				{Name: "command", Type: String, Required: true, Description: "Command line (may span lines)"},
				withDefault(iconArg, "play"),
				{Name: "in-terminal", Type: Bool, Default: "true", Description: "Run in a terminal in the bottom panel (--in-terminal=false: in the background)"},
				{Name: "on-worktree-create", Type: Bool, Default: "false", Description: "Also run (in the background) when a new thread creates its worktree"},
				repoArg, hereArg,
			},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				repoID, err := actionRepo(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.Create(ctx, connect.NewRequest(&v1.CreateActionRequest{
					RepoId: repoID, Name: a.String("name"), Command: a.String("command"), Icon: actionIcon(a.String("icon")),
					InTerminal: a.Bool("in-terminal"), OnWorktreeCreate: a.Bool("on-worktree-create"),
				}))
				if err != nil {
					return Result{}, err
				}
				act := res.Msg.GetAction()
				return Result{Message: fmt.Sprintf("added action %s (%s)", act.GetName(), act.GetId()), JSON: act}, nil
			},
		},
		Command{
			Name:        "action.edit",
			Title:       "Edit Action",
			Description: "Change an action's name, command, icon, where it runs, whether it runs for new worktrees, or its position.",
			Category:    "Action",
			Args: []ArgSpec{
				refArg,
				{Name: "name", Type: String, Description: "New name"},
				{Name: "command", Type: String, Description: "New command line"},
				iconArg,
				{Name: "in-terminal", Type: Bool, Description: "Run in a terminal (--in-terminal=false: in the background)"},
				{Name: "on-worktree-create", Type: Bool, Description: "Run when a new thread creates its worktree"},
				{Name: "position", Type: Int, Description: "Move to this 0-based place in the project's list"},
				repoArg, hereArg,
			},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				act, err := findAction(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				req := &v1.UpdateActionRequest{Id: act.GetId()}
				str := func(name string) *string {
					if !a.Has(name) {
						return nil
					}
					v := a.String(name)
					return &v
				}
				boolean := func(name string) *bool {
					if !a.Has(name) {
						return nil
					}
					v := a.Bool(name)
					return &v
				}
				req.Name, req.Command = str("name"), str("command")
				req.InTerminal, req.OnWorktreeCreate = boolean("in-terminal"), boolean("on-worktree-create")
				if a.Has("icon") {
					icon := actionIcon(a.String("icon"))
					req.Icon = &icon
				}
				if a.Has("position") {
					p := int32(a.Int("position"))
					req.Position = &p
				}
				if req.Name == nil && req.Command == nil && req.Icon == nil && req.InTerminal == nil && req.OnWorktreeCreate == nil && req.Position == nil {
					return Result{}, InvalidArg("action", "nothing to change: pass --name, --command, --icon, --in-terminal, --on-worktree-create or --position")
				}
				res, err := d.Action.Update(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				out := res.Msg.GetAction()
				return Result{Message: "updated action " + out.GetName(), JSON: out}, nil
			},
		},
		Command{
			Name:           "action.remove",
			Title:          "Remove Action",
			Description:    "Remove an action from its project. Runs in progress keep going.",
			Category:       "Action",
			Args:           []ArgSpec{refArg, repoArg, hereArg},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				act, err := findAction(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				if _, err := d.Action.Delete(ctx, connect.NewRequest(&v1.DeleteActionRequest{Id: act.GetId()})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed action " + act.GetName()}, nil
			},
		},
		Command{
			Name:  "action.run",
			Title: "Run Action",
			Description: "Run an action for the active thread (its bottom panel), else the active worktree, else the registered " +
				"worktree containing the working directory. It runs where the action says (a terminal, or the background); " +
				"--background captures its output instead, --terminal opens it as a terminal. --wait waits for it to finish, " +
				"prints a background run's output, and exits with the action's exit code.",
			Category: "Action",
			Args: []ArgSpec{
				refArg,
				{Name: "background", Type: Bool, Description: "Run in the background with captured output, whatever the action says"},
				{Name: "terminal", Type: Bool, Description: "Run in a terminal in the bottom panel, whatever the action says"},
				{Name: "wait", Type: Bool, Description: "Wait for the run to finish; print its output (background) and exit with its code"},
				{Name: "here", Type: Path, DefaultToCwd: true, Description: "Where the CLI runs: without a thread or worktree, " +
					"the registered worktree containing it owns the run (CLI default: the working directory)"},
			},
			When: canStartShell,
			WhyUnavailable: func(Context) string {
				return "an action runs for a thread or a worktree: select one, or from the CLI run inside a registered project"
			},
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				mode := v1.ActionRunMode_ACTION_RUN_MODE_UNSPECIFIED
				switch {
				case a.Bool("background") && a.Bool("terminal"):
					return Result{}, InvalidArg("background", "--background and --terminal exclude each other")
				case a.Bool("background"):
					mode = v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND
				case a.Bool("terminal"):
					mode = v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL
				}
				o, err := shellOwner(ctx, d.Repo, d.Thread, c, "", a.Path("here"),
					"action.run needs a thread, a worktree, or to run inside a registered project")
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.Run(ctx, connect.NewRequest(&v1.RunActionRequest{
					Action: a.String("action"), ThreadId: o.thread, WorktreePath: o.worktree, RepoId: o.repo, Mode: mode,
				}))
				if err != nil {
					return Result{}, err
				}
				run := res.Msg.GetRun()
				if a.Bool("wait") {
					return waitRun(ctx, d, run.GetId())
				}
				if run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL {
					return Result{Message: fmt.Sprintf("started %s in terminal %s (run %s)", run.GetActionName(), run.GetTerminalId(), run.GetId()), JSON: run}, nil
				}
				return Result{Message: fmt.Sprintf("started %s in the background (run %s); `code-foundry action wait %s` prints its output",
					run.GetActionName(), run.GetId(), run.GetId()), JSON: run}, nil
			},
		},
		Command{
			Name:        "action.wait",
			Title:       "Wait for Action Run",
			Description: "Wait for an action run to finish, print its output (a background run's last 64 KiB), and exit with its exit code.",
			Category:    "Action",
			Args:        []ArgSpec{{Name: "run", Type: String, Required: true, Positional: true, Description: "Run id (r-...)"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				return waitRun(ctx, d, a.String("run"))
			},
		},
		Command{
			Name:           "action.runs",
			Title:          "List Action Runs",
			Description:    "List a project's recent action runs (the daemon remembers the last 50 per project until it restarts), newest first.",
			Category:       "Action",
			Args:           []ArgSpec{repoArg, hereArg},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				repoID, err := actionRepo(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.List(ctx, connect.NewRequest(&v1.ListActionsRequest{RepoId: repoID}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatRuns(res.Msg.GetRuns()), JSON: res.Msg}, nil
			},
		},
	)
}

func withDefault(a ArgSpec, def string) ArgSpec {
	a.Default = def
	return a
}

// actionRepo is the project the action commands work on: --repo (id, name, or a path
// inside it; the GUI's active project), else the owner terminal.new would pick (thread,
// worktree, the CLI's working directory).
func actionRepo(ctx context.Context, d ActionDeps, c Context, a Args) (string, error) {
	if ref := strings.TrimSpace(a.String("repo")); ref != "" {
		return resolveRepoRef(ctx, d.Repo, ref)
	}
	o, err := shellOwner(ctx, d.Repo, d.Thread, c, "", a.Path("here"), noProject)
	if err != nil {
		return "", err
	}
	if o.repo == "" {
		return "", InvalidArg("repo", "thread %s has no project; %s", o.thread, noProject)
	}
	return o.repo, nil
}

// resolveRepoRef finds a registered project by id, else by name (when unique), else as
// the deepest worktree containing an absolute path.
func resolveRepoRef(ctx context.Context, repos RepoBackend, ref string) (string, error) {
	res, err := repos.List(ctx, connect.NewRequest(&v1.ListReposRequest{}))
	if err != nil {
		return "", err
	}
	var byName []string
	for _, r := range res.Msg.GetRepos() {
		if r.GetId() == ref {
			return ref, nil
		}
		if r.GetName() == ref {
			byName = append(byName, r.GetId())
		}
	}
	switch {
	case len(byName) == 1:
		return byName[0], nil
	case len(byName) > 1:
		return "", InvalidArg("repo", "%d projects are named %s; pass an id (code-foundry repo list)", len(byName), ref)
	}
	if p, err := ExpandPath(ref); err == nil && filepath.IsAbs(p) {
		if id, _, ok := ownerWorktree(res.Msg.GetRepos(), "", "", realPath(p)); ok {
			return id, nil
		}
		return "", InvalidArg("repo", "%s %s", ref, notInProject)
	}
	return "", InvalidArg("repo", "no project %q (code-foundry repo list)", ref)
}

// findAction resolves the action argument: an id anywhere, else a name in the project
// actionRepo picks.
func findAction(ctx context.Context, d ActionDeps, c Context, a Args) (*v1.Action, error) {
	ref := strings.TrimSpace(a.String("action"))
	all, err := d.Action.List(ctx, connect.NewRequest(&v1.ListActionsRequest{}))
	if err != nil {
		return nil, err
	}
	for _, act := range all.Msg.GetActions() {
		if act.GetId() == ref {
			return act, nil
		}
	}
	repoID, err := actionRepo(ctx, d, c, a)
	if err != nil {
		return nil, err
	}
	for _, act := range all.Msg.GetActions() {
		if act.GetRepoId() == repoID && strings.EqualFold(act.GetName(), ref) {
			return act, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no action %q in this project (code-foundry action list)", ref))
}

// waitRun waits for run id and reports it: a background run's output, then a line with
// the exit code, which is also the result's ExitCode.
func waitRun(ctx context.Context, d ActionDeps, id string) (Result, error) {
	res, err := d.Action.WaitRun(ctx, connect.NewRequest(&v1.WaitActionRunRequest{RunId: id}))
	if err != nil {
		return Result{}, err
	}
	run := res.Msg.GetRun()
	code := int(run.GetExitCode())
	var sb strings.Builder
	if run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND {
		if run.GetOutputTruncated() {
			sb.WriteString("[earlier output dropped; the last 64 KiB follow]\n")
		}
		if out := strings.TrimRight(run.GetOutput(), "\n"); out != "" {
			sb.WriteString(out + "\n")
		}
	}
	switch {
	case run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL && code == -1:
		fmt.Fprintf(&sb, "terminal %s was closed before %s finished (run %s)", run.GetTerminalId(), run.GetActionName(), run.GetId())
	case run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL:
		fmt.Fprintf(&sb, "%s exited with code %d in terminal %s (run %s)", run.GetActionName(), code, run.GetTerminalId(), run.GetId())
	default:
		fmt.Fprintf(&sb, "%s exited with code %d (run %s)", run.GetActionName(), code, run.GetId())
	}
	if code < 0 || code > 255 {
		code = 1
	}
	return Result{Message: sb.String(), JSON: run, ExitCode: code}, nil
}

// formatActions is action.list's table.
func formatActions(acts []*v1.Action) string {
	if len(acts) == 0 {
		return "no actions in this project (add one: code-foundry action add <name> --command '<command line>')"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "NAME\tID\tICON\tRUNS IN\tON NEW WORKTREE\tCOMMAND")
	for _, a := range acts {
		where, onCreate := "background", "no"
		if a.GetInTerminal() {
			where = "terminal"
		}
		if a.GetOnWorktreeCreate() {
			onCreate = "yes"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", a.GetName(), a.GetId(), actionIconName(a.GetIcon()), where, onCreate, oneLine(a.GetCommand()))
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

// formatRuns is action.runs' table.
func formatRuns(runs []*v1.ActionRun) string {
	if len(runs) == 0 {
		return "no action runs in this project since the daemon started"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "RUN\tACTION\tSTATE\tWHERE\tOWNER\tSTARTED")
	for _, r := range runs {
		state := "running"
		if r.GetState() == v1.ActionRunState_ACTION_RUN_STATE_EXITED {
			state = "exited " + strconv.Itoa(int(r.GetExitCode()))
		}
		where := "background"
		if r.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL {
			where = "terminal " + r.GetTerminalId()
		}
		owner := r.GetWorktreePath()
		if r.GetThreadId() != "" {
			owner = "thread " + r.GetThreadId()
		}
		started := ""
		if t := r.GetStartedAt(); t != nil {
			started = t.AsTime().Local().Format("15:04:05")
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", r.GetId(), r.GetActionName(), state, where, owner, started)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

// oneLine is a command's first line, with an ellipsis when there are more.
func oneLine(s string) string {
	first, rest, more := strings.Cut(s, "\n")
	if more && strings.TrimSpace(rest) != "" {
		return first + " …"
	}
	return first
}
