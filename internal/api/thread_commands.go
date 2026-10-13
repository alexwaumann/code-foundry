package api

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/session"
)

// A running thread's slash commands (docs/notes/slash-commands-1-daemon.md).

// SlashCommands returns the slash commands the thread offers; none when not running.
func (h *Thread) SlashCommands(ctx context.Context, req *connect.Request[v1.SlashCommandsRequest]) (*connect.Response[v1.SlashCommandsResponse], error) {
	cs, err := h.store.SlashCommands(ctx, req.Msg.GetSessionId())
	if err != nil {
		return nil, sessionError(err)
	}
	return connect.NewResponse(&v1.SlashCommandsResponse{Commands: slashCommandsToProto(cs)}), nil
}

func slashCommandsToProto(cs []session.SlashCommand) []*v1.SlashCommand {
	if len(cs) == 0 {
		return nil
	}
	out := make([]*v1.SlashCommand, len(cs))
	for i, c := range cs {
		out[i] = &v1.SlashCommand{
			Name: c.Name, Description: c.Description, ArgumentHint: c.ArgumentHint,
			Aliases: slices.Clone(c.Aliases), Builtin: c.Builtin,
		}
	}
	return out
}
