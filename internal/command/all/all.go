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
	// Terminal backs terminal.* (terminal.new also reads Repo and Session to find a
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
	// Repo backs repo.*. Nil works like Terminal.
	Repo command.RepoBackend
	// NotGit reports a context in a project without git: it gates repo.worktree.*,
	// repo.git.init, and (unless GitOps.NotGit is set) git.* and pr.*. Nil: every
	// project is git.
	NotGit command.NotGitFunc
	// Clone backs repo.clone. Nil makes it fail with Unimplemented.
	Clone command.CloneFunc
	// Projects backs repo.create, repo.github.publish and repo.delete (its NotGit
	// defaults to NotGit). A nil Backend works like Terminal.
	Projects command.ProjectDeps
	// Session backs session.*. Nil works like Terminal.
	Session command.SessionBackend
	// Thread backs thread.*. Nil works like Terminal.
	Thread command.ThreadBackend
	// GitOps backs git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url.
	// A nil Backend works like Terminal.
	GitOps command.GitOpsDeps
	// Gh backs pr.revert, pr.merge, pr.review.request and pr.refresh (the pull request detail
	// panel's actions), and reads the pull request for pr.ask, pr.explain and
	// pr.fix.findings (which also use Repo, Session, GitOps.Backend and Emitter). Nil
	// works like Terminal.
	Gh command.GhBackend
	// Settings backs settings.* and notifications.test (the alert volume). Nil works like
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
	// Action backs action.* (which also use Repo and Session to find a run's owner).
	// Nil works like Terminal.
	Action command.ActionBackend
}

// Register registers every domain's commands into r.
func Register(r *command.Registry, d Deps) error {
	if d.Emitter == nil {
		return errors.New("register commands: Emitter is required")
	}
	if d.Terminal == nil {
		d.Terminal = codefoundryv1connect.UnimplementedTerminalServiceHandler{}
	}
	if d.Repo == nil {
		d.Repo = codefoundryv1connect.UnimplementedRepoServiceHandler{}
	}
	if d.Session == nil {
		d.Session = codefoundryv1connect.UnimplementedSessionServiceHandler{}
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
	if d.Update == nil {
		d.Update = codefoundryv1connect.UnimplementedUpdateServiceHandler{}
	}
	if d.GitOps.NotGit == nil {
		d.GitOps.NotGit = d.NotGit
	}
	if d.Projects.NotGit == nil {
		d.Projects.NotGit = d.NotGit
	}
	return errors.Join(
		command.RegisterDaemon(r, d.Daemon),
		command.RegisterUI(r, d.Emitter),
		command.RegisterTerminal(r, command.TerminalDeps{Terminal: d.Terminal, Repo: d.Repo, Session: d.Session, IsShell: d.IsShellTerminal, AwaitOutput: d.AwaitTerminalOutput, BracketedPaste: d.TerminalBracketedPaste}),
		command.RegisterRepo(r, d.Repo, d.NotGit),
		command.RegisterRepoAdd(r, d.Repo, d.Clone),
		command.RegisterRepoCleanup(r, command.RepoCleanupDeps{Repo: d.Repo, GitOps: d.GitOps.Backend, NotGit: d.NotGit}),
		command.RegisterProjects(r, d.Projects),
		command.RegisterSession(r, d.Session, d.Emitter),
		command.RegisterThread(r, d.Thread),
		command.RegisterMcp(r, d.Thread, d.Emitter),
		command.RegisterAgents(r, d.Thread, d.Emitter),
		command.RegisterSlash(r, d.Thread),
		command.RegisterGitOps(r, d.GitOps),
		command.RegisterPullRequest(r, d.Gh),
		command.RegisterPullRequestSessions(r, command.PullRequestSessionDeps{
			Gh: d.Gh, Repo: d.Repo, Session: d.Session, GitOps: d.GitOps.Backend, Emitter: d.Emitter,
		}),
		command.RegisterSettings(r, d.Settings, d.Emitter, d.Reveal),
		command.RegisterNotifications(r, d.Settings, d.Emitter),
		command.RegisterUpdate(r, command.UpdateDeps{Update: d.Update, Session: d.Session, Restart: d.Restart, Daemon: d.Daemon}),
		command.RegisterView(r, d.Emitter),
		command.RegisterUsage(r, d.Session),
		command.RegisterWorkspace(r, d.Workspace),
		command.RegisterAction(r, command.ActionDeps{Action: d.Action, Repo: d.Repo, Session: d.Session}),
	)
}
