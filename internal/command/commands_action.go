package command

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

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
	StopRun(context.Context, *connect.Request[v1.StopActionRunRequest]) (*connect.Response[v1.StopActionRunResponse], error)
	LastRun(context.Context, *connect.Request[v1.LastActionRunRequest]) (*connect.Response[v1.LastActionRunResponse], error)
}

var (
	_ ActionBackend = codefoundryv1connect.ActionServiceHandler(nil)
	_ ActionBackend = codefoundryv1connect.ActionServiceClient(nil)
)

// ActionDeps are the action.* commands' dependencies. Project and Thread find the
// project and the owner of a run the way terminal.new finds a shell's.
type ActionDeps struct {
	Action  ActionBackend
	Project ProjectBackend
	Thread  ThreadBackend
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
	return hasThread(c) || hasProjectOrWorktree(c) || c.ActiveView == ""
}

// noProject is how the action commands refuse a context without a project.
const noProject = "actions belong to a project: pass --project, select a thread or a worktree, or run inside a registered project"

// RegisterAction registers action.list, action.add, action.edit, action.remove,
// action.run, action.wait, action.runs and action.last.
func RegisterAction(r *Registry, d ActionDeps) error {
	r.SetIDLister(RunID, runIDs(d.Action))
	projectArg := ArgSpec{Name: "project", Type: String, Context: ContextProject,
		Description: "Project: id, name, or a path inside it (default: the thread's, the worktree's, or the working directory's)"}
	hereArg := ArgSpec{Name: "here", Type: Path, DefaultToCwd: true,
		Description: "Where the CLI runs: without a thread, worktree or --project, its project is used (CLI default: the working directory)"}
	refArg := ArgSpec{Name: "action", Type: String, Required: true, Positional: true, Description: "Action name (ignoring case) or id"}
	iconArg := ArgSpec{Name: "icon", Type: Enum, Enum: actionIconNames(), Description: "Icon"}
	whyNoProject := func(Context) string { return noProject }
	return r.RegisterAll(
		Command{
			Name:      "action.list",
			NoPalette: true,
			ReadOnly:  true,
			Title:     "List Actions",
			Description: "List a project's actions: the commands `action run` starts, in order, with their ids. " +
				"The project is the thread's, else the worktree's, else the working directory's.",
			Category:       "Action",
			NoKeybinding:   true,
			Args:           []ArgSpec{projectArg, hereArg},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				projectID, err := actionProject(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.List(ctx, connect.NewRequest(&v1.ListActionsRequest{ProjectId: projectID}))
				if err != nil {
					return Result{}, err
				}
				pick, err := d.Action.LastRun(ctx, connect.NewRequest(&v1.LastActionRunRequest{ProjectId: projectID, ThreadId: c.ActiveThreadID}))
				if err != nil {
					return Result{}, err
				}
				now := time.Now()
				msg := formatActions(res.Msg.GetActions(), res.Msg.GetLastRuns(), c.ActiveThreadID, now)
				if line := formatPick(pick.Msg, c.ActiveThreadID, now); line != "" {
					msg += "\n" + line
				}
				return Result{Message: msg, JSON: res.Msg}, nil
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
				projectArg, hereArg,
			},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				projectID, err := actionProject(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.Create(ctx, connect.NewRequest(&v1.CreateActionRequest{
					ProjectId: projectID, Name: a.String("name"), Command: a.String("command"), Icon: actionIcon(a.String("icon")),
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
			NoPalette:   true,
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
				projectArg, hereArg,
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
			NoPalette:      true,
			Title:          "Remove Action",
			Description:    "Remove an action from its project. Runs in progress keep going.",
			Category:       "Action",
			Args:           []ArgSpec{refArg, projectArg, hereArg},
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
			Name:      "action.run",
			NoPalette: true,
			Title:     "Run Action",
			Description: "Run an action for the active thread (its bottom panel), else the active worktree, else the registered " +
				"worktree containing the working directory. It runs where the action says (a terminal, or the background); " +
				"--background captures its output instead, --terminal opens it as a terminal. --wait waits for it to finish, " +
				"prints a background run's output, and exits with the action's exit code.",
			Category: "Action",
			Args: []ArgSpec{
				refArg,
				{Name: "background", Type: Bool, Description: "Run in the background with captured output, whatever the action says"},
				{Name: "terminal", Type: Bool, Description: "Run in a terminal in the bottom panel, whatever the action says"},
				{Name: "wait", Type: Bool, Description: "Wait for the run to finish; print its output (background) and exit with its code. " +
					"Interrupting the wait stops a background run"},
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
				o, err := shellOwner(ctx, d.Project, d.Thread, c, "", a.Path("here"),
					"action.run needs a thread, a worktree, or to run inside a registered project")
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.Run(ctx, connect.NewRequest(&v1.RunActionRequest{
					Action: a.String("action"), ThreadId: o.thread, WorktreePath: o.worktree, ProjectId: o.project, Mode: mode,
				}))
				if err != nil {
					return Result{}, err
				}
				run := res.Msg.GetRun()
				if a.Bool("wait") {
					out, err := waitRun(ctx, d, run.GetId())
					if err != nil && ctx.Err() != nil && run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_BACKGROUND {
						// The caller went away (Ctrl-C, a timed-out tool call): the background
						// run it started for itself would go on unseen, so it stops too. A
						// terminal run stays: it is on screen and closes with its tab.
						stopAbandoned(ctx, d, run.GetId())
					}
					return out, err
				}
				if run.GetMode() == v1.ActionRunMode_ACTION_RUN_MODE_TERMINAL {
					return Result{Message: fmt.Sprintf("started %s in terminal %s (run %s)", run.GetActionName(), run.GetTerminalId(), run.GetId()), JSON: run}, nil
				}
				return Result{Message: fmt.Sprintf("started %s in the background (run %s); `code-foundry action wait %s` prints its output",
					run.GetActionName(), run.GetId(), run.GetId()), JSON: run}, nil
			},
		},
		Command{
			Name:      "action.wait",
			NoPalette: true,
			ReadOnly:  true,
			Title:     "Wait for Action Run",
			Description: "Wait for an action run to finish, print its output (a background run's last 64 KiB), and exit with its exit code. " +
				"Interrupting the wait leaves the run going (action stop ends it).",
			Category:     "Action",
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "run", Type: String, Required: true, Positional: true, ID: RunID, Description: "Run id (r-...)" + IDHelp}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				return waitRun(ctx, d, a.String("run"))
			},
		},
		Command{
			Name:      "action.stop",
			NoPalette: true,
			Title:     "Stop Action Run",
			Description: "Stop a running action run: a background run gets SIGTERM, then SIGKILL after a few seconds; a terminal run's " +
				"terminal is killed. A finished run is left as it is. `code-foundry action wait <run>` waits for the end.",
			Category:     "Action",
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "run", Type: String, Required: true, Positional: true, ID: RunID, Description: "Run id (r-...)" + IDHelp}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := d.Action.StopRun(ctx, connect.NewRequest(&v1.StopActionRunRequest{RunId: a.String("run")}))
				if err != nil {
					return Result{}, err
				}
				run := res.Msg.GetRun()
				if run.GetState() == v1.ActionRunState_ACTION_RUN_STATE_EXITED {
					return Result{Message: fmt.Sprintf("%s had finished already, with code %d (run %s)", run.GetActionName(), run.GetExitCode(), run.GetId()), JSON: run}, nil
				}
				return Result{Message: fmt.Sprintf("stopping %s (run %s)", run.GetActionName(), run.GetId()), JSON: run}, nil
			},
		},
		Command{
			Name:           "action.runs",
			NoPalette:      true,
			ReadOnly:       true,
			Title:          "List Action Runs",
			Description:    "List a project's recent action runs (the daemon remembers the last 50 per project until it restarts), newest first.",
			Category:       "Action",
			NoKeybinding:   true,
			Args:           []ArgSpec{projectArg, hereArg},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				projectID, err := actionProject(ctx, d, c, a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.List(ctx, connect.NewRequest(&v1.ListActionsRequest{ProjectId: projectID}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatRuns(res.Msg.GetRuns()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:      "action.last",
			NoPalette: true,
			ReadOnly:  true,
			Title:     "Action to Run Again",
			Description: "The action a thread's info card offers: the one last run in the thread, else the project's most " +
				"recently run one, else the project's first. Runs started for a new worktree do not count.",
			Category:     "Action",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID, Description: "Thread id (default: the active thread; none: the project's pick)" + IDHelp},
				projectArg, hereArg,
			},
			When:           canUseActions,
			WhyUnavailable: whyNoProject,
			Run: func(ctx context.Context, c Context, a Args) (Result, error) {
				thread := a.String("thread")
				projectID, err := actionProject(ctx, d, c.With(ContextThread, thread), a)
				if err != nil {
					return Result{}, err
				}
				res, err := d.Action.LastRun(ctx, connect.NewRequest(&v1.LastActionRunRequest{ProjectId: projectID, ThreadId: thread}))
				if err != nil {
					return Result{}, err
				}
				msg := formatPick(res.Msg, thread, time.Now())
				if msg == "" {
					msg = "no actions in this project (add one: code-foundry action add <name> --command '<command line>')"
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
	)
}

func withDefault(a ArgSpec, def string) ArgSpec {
	a.Default = def
	return a
}

// actionProject is the project the action commands work on: --project (id, name, or a path
// inside it; the GUI's active project), else the owner terminal.new would pick (thread,
// worktree, the CLI's working directory).
func actionProject(ctx context.Context, d ActionDeps, c Context, a Args) (string, error) {
	if ref := strings.TrimSpace(a.String("project")); ref != "" {
		return resolveProjectRef(ctx, d.Project, ref)
	}
	o, err := shellOwner(ctx, d.Project, d.Thread, c, "", a.Path("here"), noProject)
	if err != nil {
		return "", err
	}
	if o.project == "" {
		return "", InvalidArg("project", "thread %s has no project; %s", o.thread, noProject)
	}
	return o.project, nil
}

// resolveProjectRef finds a registered project by id, else by name (when unique), else as
// the deepest worktree containing an absolute path.
func resolveProjectRef(ctx context.Context, projects ProjectBackend, ref string) (string, error) {
	return projectRef(ctx, projects, ref, true)
}

// projectRef is resolveProjectRef; unless strict, a ref that is neither an id, a name
// nor a path is returned as it is, for the command's backend to report (a ProjectID
// arg's RefResolver).
func projectRef(ctx context.Context, projects ProjectBackend, ref string, strict bool) (string, error) {
	res, err := projects.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return "", err
	}
	var byName []string
	for _, r := range res.Msg.GetProjects() {
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
		return "", InvalidArg("project", "%d projects are named %s; pass an id (code-foundry project list)", len(byName), ref)
	}
	if p, err := ExpandPath(ref); err == nil && filepath.IsAbs(p) {
		if id, _, ok := ownerWorktree(res.Msg.GetProjects(), "", "", realPath(p)); ok {
			return id, nil
		}
		return "", InvalidArg("project", "%s %s", ref, notInProject)
	}
	if !strict {
		return ref, nil
	}
	return "", InvalidArg("project", "no project %q (code-foundry project list)", ref)
}

// findAction resolves the action argument: an id anywhere, else a name in the project
// actionProject picks.
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
	projectID, err := actionProject(ctx, d, c, a)
	if err != nil {
		return nil, err
	}
	for _, act := range all.Msg.GetActions() {
		if act.GetProjectId() == projectID && strings.EqualFold(act.GetName(), ref) {
			return act, nil
		}
	}
	return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no action %q in this project (code-foundry action list)", ref))
}

// stopAbandoned stops run id, which action.run --wait started, after its caller went
// away (ctx ended): the stop itself must not depend on ctx.
func stopAbandoned(ctx context.Context, d ActionDeps, id string) {
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, err := d.Action.StopRun(sctx, connect.NewRequest(&v1.StopActionRunRequest{RunId: id})); err != nil {
		slog.Warn("action.run --wait: stop the abandoned run", "run", id, "err", err)
	}
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

// formatActions is action.list's table: each action and when it last ran (its newest
// run record), relative to now; "here" is a run in thread.
func formatActions(acts []*v1.Action, last []*v1.ActionRunRecord, thread string, now time.Time) string {
	if len(acts) == 0 {
		return "no actions in this project (add one: code-foundry action add <name> --command '<command line>')"
	}
	lastOf := make(map[string]*v1.ActionRunRecord, len(last))
	for _, r := range last {
		lastOf[r.GetActionId()] = r
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "NAME\tID\tICON\tRUNS IN\tON NEW WORKTREE\tLAST RUN\tCOMMAND")
	for _, a := range acts {
		where, onCreate := "background", "no"
		if a.GetInTerminal() {
			where = "terminal"
		}
		if a.GetOnWorktreeCreate() {
			onCreate = "yes"
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", a.GetName(), a.GetId(), actionIconName(a.GetIcon()), where, onCreate,
			lastRunCell(lastOf[a.GetId()], thread, now), oneLine(a.GetCommand()))
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

// lastRunCell is "never", else when and where: "3 min ago, here", "2 h ago, thread s-1",
// "just now, worktree".
func lastRunCell(r *v1.ActionRunRecord, thread string, now time.Time) string {
	if r == nil || r.GetStartedAt() == nil {
		return "never"
	}
	where := "worktree"
	switch {
	case thread != "" && r.GetThreadId() == thread:
		where = "here"
	case r.GetThreadId() != "":
		where = "thread " + r.GetThreadId()
	}
	return mcpAgo(now.Sub(r.GetStartedAt().AsTime())) + ", " + where
}

// actionPickReasons is why LastRun chose its action, by source.
var actionPickReasons = map[v1.ActionPickSource]string{
	v1.ActionPickSource_ACTION_PICK_SOURCE_THREAD:  "ran last in this thread",
	v1.ActionPickSource_ACTION_PICK_SOURCE_PROJECT: "ran last in this project",
	v1.ActionPickSource_ACTION_PICK_SOURCE_FIRST:   "the project's first action; none has run yet",
}

// formatPick is the action a thread's card offers and why; "" without one.
func formatPick(p *v1.LastActionRunResponse, thread string, now time.Time) string {
	if p.GetAction() == nil {
		return ""
	}
	who := "the project"
	if thread != "" {
		who = "thread " + thread
	}
	line := fmt.Sprintf("to run again for %s: %s (%s), %s", who, p.GetAction().GetName(), p.GetAction().GetId(), actionPickReasons[p.GetSource()])
	if l := p.GetLast(); l != nil && l.GetStartedAt() != nil {
		line += ", " + mcpAgo(now.Sub(l.GetStartedAt().AsTime()))
	}
	return line
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
