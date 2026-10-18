package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Prefix is where plugin commands live: plugin.<name>.<command>.
func Prefix(name string) string { return "plugin." + name + "." }

var argTypes = map[string]command.ArgType{
	"": command.String, pluginsdk.ArgString: command.String, pluginsdk.ArgBool: command.Bool,
	pluginsdk.ArgInt: command.Int, pluginsdk.ArgEnum: command.Enum, pluginsdk.ArgPath: command.Path,
}

var argContexts = map[string]command.ContextField{
	"": command.NoContext, pluginsdk.ArgContextThread: command.ContextThread, pluginsdk.ArgContextProject: command.ContextProject,
	pluginsdk.ArgContextWorktree: command.ContextWorktree, pluginsdk.ArgContextTerminal: command.ContextTerminal,
}

// commandsFor maps a manifest's commands onto registry commands, plus a show command per
// surface (show.go). A command's when clause is its When; it is available whatever the
// plugin's state and says why when the plugin is down.
func (m *Manager) commandsFor(name string, mf pluginsdk.Manifest) []command.Command {
	out := make([]command.Command, 0, len(mf.Commands))
	for _, spec := range mf.Commands {
		args := make([]command.ArgSpec, len(spec.Args))
		for i, a := range spec.Args {
			args[i] = command.ArgSpec{
				Name: a.Name, Type: argTypes[a.Type], Required: a.Required, Description: a.Description,
				Enum: a.Enum, Default: a.Default, Positional: a.Positional, Context: argContexts[a.Context],
			}
		}
		when, why := m.commandWhen(spec.When)
		out = append(out, command.Command{
			When:           when,
			WhyUnavailable: why,
			Name:           Prefix(name) + spec.Name,
			Title:          spec.Title,
			Description:    spec.Description,
			Category:       mf.DisplayNameOr(),
			Args:           args,
			Confirm:        spec.Confirm,
			Run: func(ctx context.Context, uctx command.Context, a command.Args) (command.Result, error) {
				return m.runCommand(ctx, name, spec, uctx, a)
			},
		})
	}
	return append(out, m.showCommands(name, mf)...)
}

// register puts e's commands in the registry. opMu held.
func (m *Manager) register(e *entry) {
	m.mu.Lock()
	name, mf := e.name, e.manifest
	m.mu.Unlock()
	err := m.opts.Commands.ReplacePrefix(Prefix(name), m.commandsFor(name, mf))
	m.update(name, nil, func(e *entry) {
		e.regErr = ""
		if err != nil {
			e.regErr = "commands not registered: " + err.Error()
		}
	})
	if err != nil {
		m.log.Warn("plugin commands not registered", "plugin", name, "err", err)
	}
}

// unregister removes a plugin's commands. opMu held.
func (m *Manager) unregister(name string) {
	if err := m.opts.Commands.ReplacePrefix(Prefix(name), nil); err != nil {
		m.log.Warn("plugin commands not removed", "plugin", name, "err", err)
	}
}

// rawArgs turns validated args back into the strings the protocol carries.
func rawArgs(specs []pluginsdk.ArgSpec, a command.Args) map[string]string {
	out := map[string]string{}
	for _, s := range specs {
		if !a.Has(s.Name) {
			continue
		}
		switch argTypes[s.Type] {
		case command.Bool:
			out[s.Name] = strconv.FormatBool(a.Bool(s.Name))
		case command.Int:
			out[s.Name] = strconv.Itoa(a.Int(s.Name))
		default:
			out[s.Name] = a.String(s.Name)
		}
	}
	return out
}

// runCommand forwards one invocation to the plugin as command/invoke.
func (m *Manager) runCommand(ctx context.Context, name string, spec pluginsdk.CommandSpec, uctx command.Context, a command.Args) (command.Result, error) {
	m.mu.Lock()
	var conn *pluginsdk.Conn
	var why string
	if e := m.entries[name]; e != nil {
		if e.actor != nil {
			conn = e.actor.running()
		}
		if conn == nil || e.state != StateRunning {
			conn, why = nil, m.whyDownLocked(e)
		}
	}
	m.mu.Unlock()
	if conn == nil {
		if why == "" {
			why = "plugin " + name + " is not installed"
		}
		return command.Result{}, fmt.Errorf("%w: %s", command.ErrUnavailable, why)
	}
	timeout := time.Duration(spec.Timeout()) * time.Second
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var res pluginsdk.CommandResult
	err := conn.Call(cctx, pluginsdk.MethodCommandInvoke, pluginsdk.CommandRequest{
		Command: spec.Name, Args: rawArgs(spec.Args, a),
		Context: pluginsdk.UiContext{
			ThreadID: uctx.ActiveThreadID, ProjectID: uctx.ActiveProjectID, WorktreePath: uctx.ActiveWorktreePath,
			TerminalID: uctx.ActiveTerminalID, WorkspaceID: uctx.ActiveWorkspaceID, View: uctx.ActiveView,
		},
	}, &res)
	if err != nil {
		var perr *pluginsdk.Error
		switch {
		case errors.As(err, &perr) && perr.Code == pluginsdk.CodeInvalidParams:
			return command.Result{}, command.InvalidArg("", "%s", perr.Message)
		case errors.As(err, &perr):
			return command.Result{}, errors.New(perr.Message)
		case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
			return command.Result{}, fmt.Errorf("plugin %s did not answer %s within %s", name, spec.Name, timeout)
		case errors.Is(err, pluginsdk.ErrClosed):
			return command.Result{}, fmt.Errorf("plugin %s stopped while running %s", name, spec.Name)
		}
		return command.Result{}, fmt.Errorf("plugin %s: %w", name, err)
	}
	out := command.Result{Message: res.Message, ExitCode: res.ExitCode}
	if len(res.JSON) > 0 && json.Valid(res.JSON) {
		out.JSON = res.JSON
	}
	return out, nil
}

// whyDownLocked explains why a plugin cannot take a command now. m.mu held.
func (m *Manager) whyDownLocked(e *entry) string {
	switch e.state {
	case StateStarting:
		return "plugin " + e.name + " is starting; try again in a moment"
	case StateCrashed:
		in := max(e.nextRestartAt.Sub(m.opts.Now()), 0).Round(time.Second)
		return fmt.Sprintf("plugin %s crashed (%s); next try in %s", e.name, e.lastError, in)
	case StateFailed:
		return fmt.Sprintf("plugin %s failed (%s); run `code-foundry plugin restart %s`", e.name, e.lastError, e.name)
	case StateDisabled:
		return "plugin " + e.name + " is disabled"
	}
	return "plugin " + e.name + " is not running"
}
