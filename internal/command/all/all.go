// Package all registers every command domain into a registry. It is the one place the
// daemon wires commands to their dependencies: adding a domain means adding a field to
// Deps and one Register call here.
package all

import (
	"context"
	"errors"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Deps are the dependencies of all command domains.
type Deps struct {
	Daemon  command.DaemonInfo
	Emitter command.Emitter
	// Terminal backs terminal.* (terminal.new also reads Project and Thread to find a
	// shell's owner). Nil registers the commands against
	// UnimplementedTerminalServiceHandler, so they list but fail with Unimplemented.
	Terminal command.TerminalBackend
	// IsShellTerminal reports whether a terminal is a bottom panel terminal (a shell
	// terminal.new started, or an action run; termlabel.IsPanel); it gates
	// terminal.close. Nil: any terminal.
	IsShellTerminal func(id string) bool
	// AwaitTerminalOutput blocks until a new terminal has printed something (its
	// prompt); terminal.new --run waits with it before typing. Nil: it types at once.
	AwaitTerminalOutput func(ctx context.Context, id string) error
	// TerminalBracketedPaste reports whether a terminal reads bracketed pastes;
	// terminal.new --run then pastes its command. Nil: it types it.
	TerminalBracketedPaste func(ctx context.Context, id string) (bool, error)
	// Project backs project.*. Nil works like Terminal.
	Project command.ProjectBackend
	// NotGit reports a context in a project without git: it gates project.worktree.*,
	// project.git.init, and (unless GitOps.NotGit is set) git.* and pr.*. Nil: every
	// project is git.
	NotGit command.NotGitFunc
	// Clone backs project.clone. Nil makes it fail with Unimplemented.
	Clone command.CloneFunc
	// Projects backs project.create, project.github.publish and project.delete (its NotGit
	// defaults to NotGit). A nil Backend works like Terminal.
	NewProjects command.NewProjectDeps
	// Thread backs thread.*. Nil works like Terminal.
	Thread command.ThreadBackend
	// GitOps backs git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url.
	// A nil Backend works like Terminal.
	GitOps command.GitOpsDeps
	// Gh backs pr.revert, pr.merge, pr.review.request, pr.refresh, pr.review and
	// pr.comment (the pull request detail panel's actions), and reads the pull request for pr.ask, pr.explain and
	// pr.fix.findings (which also use Project, Thread, GitOps.Backend and Emitter). Nil
	// works like Terminal.
	Gh command.GhBackend
	// Settings backs settings.*, theme.* and notifications.test (the alert volume). Nil works like
	// Terminal.
	Settings command.SettingsBackend
	// Reveal shows a file in Finder (settings.reveal). Nil: command.RevealInFinder.
	Reveal command.RevealFunc
	// Update backs app.*. Nil works like Terminal.
	Update command.UpdateBackend
	// Restart backs daemon.restart (see command.UpdateDeps). Nil makes it fail.
	Restart func()
	// Workspace backs workspace.*. Nil works like Terminal.
	Workspace command.WorkspaceBackend
	// Action backs action.* (which also use Project and Thread to find a run's owner).
	// Nil works like Terminal.
	Action command.ActionBackend
	// Plugin backs plugin.* (the management verbs; a plugin's own commands come from the
	// plugin store). Nil works like Terminal.
	Plugin command.PluginBackend
	// PluginSurface backs plugin.surface and plugin.act. Nil works like Terminal.
	PluginSurface command.PluginSurfaceBackend
	// PluginRegistry backs plugin.browse, plugin.install, plugin.update and
	// plugin.uninstall. Nil works like Terminal.
	PluginRegistry command.PluginRegistryBackend
	// PullRequestChecks backs pr.checks (a nil Gh works like Terminal).
	PullRequestChecks command.PullRequestChecksDeps
	// Skills backs skill.* (skill.setup also uses Terminal, Project and Thread). Nil
	// registers them failing with Unimplemented.
	Skills command.SkillBackend
	// Ember backs ember.* (ember.enable and ember.disable also use Settings). Nil
	// registers them failing with Unimplemented.
	Ember command.EmberBackend
	// Memory backs memory.* (the app memory). Nil registers them failing with
	// Unimplemented.
	Memory command.MemoryBackend
}

// Register registers every domain's commands into r.
func Register(r *command.Registry, d Deps) error {
	if d.Emitter == nil {
		return errors.New("register commands: Emitter is required")
	}
	if d.Terminal == nil {
		d.Terminal = codefoundryv1connect.UnimplementedTerminalServiceHandler{}
	}
	if d.Project == nil {
		d.Project = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	if d.Thread == nil {
		d.Thread = codefoundryv1connect.UnimplementedThreadServiceHandler{}
	}
	if d.Settings == nil {
		d.Settings = codefoundryv1connect.UnimplementedSettingsServiceHandler{}
	}
	if d.Workspace == nil {
		d.Workspace = codefoundryv1connect.UnimplementedWorkspaceServiceHandler{}
	}
	if d.Action == nil {
		d.Action = codefoundryv1connect.UnimplementedActionServiceHandler{}
	}
	if d.Plugin == nil {
		d.Plugin = codefoundryv1connect.UnimplementedPluginServiceHandler{}
	}
	if d.PluginSurface == nil {
		d.PluginSurface = codefoundryv1connect.UnimplementedPluginServiceHandler{}
	}
	if d.PluginRegistry == nil {
		d.PluginRegistry = codefoundryv1connect.UnimplementedPluginServiceHandler{}
	}
	if d.Update == nil {
		d.Update = codefoundryv1connect.UnimplementedUpdateServiceHandler{}
	}
	if d.GitOps.NotGit == nil {
		d.GitOps.NotGit = d.NotGit
	}
	if d.NewProjects.NotGit == nil {
		d.NewProjects.NotGit = d.NotGit
	}
	return errors.Join(
		command.RegisterDaemon(r, d.Daemon),
		command.RegisterUI(r, d.Emitter),
		command.RegisterTerminal(r, command.TerminalDeps{Terminal: d.Terminal, Project: d.Project, Thread: d.Thread, IsShell: d.IsShellTerminal, AwaitOutput: d.AwaitTerminalOutput, BracketedPaste: d.TerminalBracketedPaste}),
		command.RegisterProject(r, d.Project, d.NotGit),
		command.RegisterProjectAdd(r, d.Project, d.Clone),
		command.RegisterProjectCleanup(r, command.ProjectCleanupDeps{Project: d.Project, GitOps: d.GitOps.Backend, NotGit: d.NotGit}),
		command.RegisterNewProjects(r, d.NewProjects),
		command.RegisterThreadLifecycle(r, d.Thread, d.Emitter),
		command.RegisterThreadList(r, command.ThreadListDeps{Thread: d.Thread, Project: d.Project}),
		command.RegisterThreadReports(r, d.Thread),
		command.RegisterThread(r, d.Thread),
		command.RegisterMcp(r, d.Thread, d.Emitter),
		command.RegisterAgents(r, d.Thread, d.Emitter),
		command.RegisterSlash(r, d.Thread),
		command.RegisterGitOps(r, d.GitOps),
		command.RegisterPullRequest(r, d.Gh),
		command.RegisterPullRequestThreads(r, command.PullRequestThreadDeps{
			Gh: d.Gh, Project: d.Project, Thread: d.Thread, GitOps: d.GitOps.Backend, Emitter: d.Emitter,
		}),
		command.RegisterSettings(r, d.Settings, d.Emitter, d.Reveal),
		command.RegisterNotifications(r, d.Settings, d.Emitter),
		command.RegisterTheme(r, d.Settings),
		command.RegisterThemePick(r, d.Emitter),
		command.RegisterUpdate(r, command.UpdateDeps{Update: d.Update, Thread: d.Thread, Restart: d.Restart, Daemon: d.Daemon}),
		command.RegisterView(r, d.Emitter, d.Thread),
		command.RegisterUsage(r, d.Thread),
		command.RegisterWorkspace(r, d.Workspace),
		command.RegisterAction(r, command.ActionDeps{Action: d.Action, Project: d.Project, Thread: d.Thread}),
		command.RegisterPlugin(r, d.Plugin),
		command.RegisterPluginSurface(r, d.PluginSurface),
		command.RegisterPluginOwned(r, command.PluginOwnedDeps{Thread: d.Thread, Project: d.Project, Terminal: d.Terminal}),
		command.RegisterPluginRegistry(r, d.PluginRegistry, d.Thread),
		command.RegisterPullRequestChecks(r, d.PullRequestChecks),
		command.RegisterSkill(r, command.SkillDeps{Skills: d.Skills, Terminal: d.Terminal, Project: d.Project, Thread: d.Thread}),
		command.RegisterEmber(r, command.EmberDeps{Ember: d.Ember, Settings: d.Settings, Thread: d.Thread}),
		command.RegisterMemory(r, d.Memory),
	)
}
