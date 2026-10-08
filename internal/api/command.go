package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/command"
)

// Command implements codefoundryv1connect.CommandServiceHandler over a command.Registry.
type Command struct {
	reg *command.Registry
}

var _ codefoundryv1connect.CommandServiceHandler = (*Command)(nil)

// NewCommand returns a CommandService handler for reg.
func NewCommand(reg *command.Registry) *Command { return &Command{reg: reg} }

// Route mounts the service.
func (h *Command) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewCommandServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// List returns the commands available in the request's context.
func (h *Command) List(_ context.Context, req *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	listed := h.reg.List(contextFromProto(req.Msg.GetContext()), req.Msg.GetIncludeUnavailable())
	out := make([]*v1.Command, len(listed))
	for i, c := range listed {
		out[i] = commandToProto(c)
	}
	return connect.NewResponse(&v1.ListCommandsResponse{Commands: out}), nil
}

// Invoke runs a command.
func (h *Command) Invoke(ctx context.Context, req *connect.Request[v1.InvokeCommandRequest]) (*connect.Response[v1.InvokeCommandResponse], error) {
	res, err := h.reg.Invoke(ctx, contextFromProto(req.Msg.GetContext()), req.Msg.GetName(), req.Msg.GetArgs(),
		command.Confirmed(req.Msg.GetConfirmed()))
	if err != nil {
		return nil, commandError(err)
	}
	js, err := res.EncodeJSON()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&v1.InvokeCommandResponse{Message: res.Message, ResultJson: js}), nil
}

// commandError maps registry and command errors to Connect errors. Errors that already
// carry a Connect code (from a store-backed command's backend) keep it. A command that
// needs confirmation fails with FailedPrecondition and a ConfirmationRequired detail.
func commandError(err error) error {
	var (
		ce      *connect.Error
		confirm *command.ConfirmError
	)
	switch {
	case errors.As(err, &confirm):
		out := connect.NewError(connect.CodeFailedPrecondition, err)
		if d, derr := connect.NewErrorDetail(&v1.ConfirmationRequired{
			Command: confirm.Command, Message: confirm.Message, Title: confirm.Title,
		}); derr == nil {
			out.AddDetail(d)
		}
		return out
	case errors.Is(err, command.ErrUnknownCommand):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, command.ErrInvalidArgs):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, command.ErrUnavailable):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.As(err, &ce):
		return ce
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	default:
		return connect.NewError(connect.CodeUnknown, err)
	}
}

func contextFromProto(c *v1.UiContext) command.Context {
	return command.Context{
		ActiveTerminalID:   c.GetActiveTerminalId(),
		ActiveSessionID:    c.GetActiveSessionId(),
		ActiveRepoID:       c.GetActiveRepoId(),
		ActiveWorktreePath: c.GetActiveWorktreePath(),
		ActiveView:         c.GetActiveView(),
	}
}

var argTypes = map[command.ArgType]v1.ArgType{
	command.String: v1.ArgType_ARG_TYPE_STRING,
	command.Bool:   v1.ArgType_ARG_TYPE_BOOL,
	command.Int:    v1.ArgType_ARG_TYPE_INT,
	command.Enum:   v1.ArgType_ARG_TYPE_ENUM,
	command.Path:   v1.ArgType_ARG_TYPE_PATH,
}

// commandToProto maps a listed command. A required arg that can default from the
// caller's context is sent as not required (the caller may omit it) and its description
// says where the default comes from.
func commandToProto(c command.Listed) *v1.Command {
	args := make([]*v1.ArgSpec, len(c.Args))
	for i, a := range c.Args {
		desc := a.Description
		if a.Context != command.NoContext {
			desc += " (default: " + a.Context.Describe() + ")"
		}
		args[i] = &v1.ArgSpec{
			Name:         a.Name,
			Type:         argTypes[a.Type],
			Required:     a.Required && a.Context == command.NoContext,
			Description:  desc,
			EnumValues:   a.Enum,
			DefaultValue: a.Default,
			Positional:   a.Positional,
		}
	}
	return &v1.Command{
		Name:                 c.Name,
		Title:                c.Title,
		Description:          c.Description,
		Category:             c.Category,
		Args:                 args,
		Keybindings:          c.Keybindings,
		Available:            c.Available,
		RequiresConfirmation: c.Confirm != "",
	}
}
