// Package all registers every command domain into a registry. It is the one place the
// daemon wires commands to their dependencies: adding a domain means adding a field to
// Deps and one Register call here.
package all

import (
	"errors"

	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/command"
)

// Deps are the dependencies of all command domains.
type Deps struct {
	Daemon  command.DaemonInfo
	Emitter command.Emitter
	// Terminal backs terminal.*. Nil registers the commands against
	// UnimplementedTerminalServiceHandler, so they list but fail with Unimplemented.
	Terminal command.TerminalBackend
	// Repo backs repo.*. Nil works like Terminal.
	Repo command.RepoBackend
	// Session backs session.*. Nil works like Terminal.
	Session command.SessionBackend
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
	return errors.Join(
		command.RegisterDaemon(r, d.Daemon),
		command.RegisterUI(r, d.Emitter),
		command.RegisterTerminal(r, d.Terminal),
		command.RegisterRepo(r, d.Repo),
		command.RegisterSession(r, d.Session, d.Emitter),
	)
}
