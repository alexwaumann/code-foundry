package client

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
)

// ListCommands calls CommandService.List. Errors wrap the *connect.Error.
func (c *Client) ListCommands(ctx context.Context, uctx *v1.UiContext, includeUnavailable bool) ([]*v1.Command, error) {
	res, err := c.Command.List(ctx, connect.NewRequest(&v1.ListCommandsRequest{
		Context: uctx, IncludeUnavailable: includeUnavailable,
	}))
	if err != nil {
		return nil, fmt.Errorf("list commands: %w", err)
	}
	return res.Msg.GetCommands(), nil
}

// WatchIntents opens UiService.WatchIntents and returns once the daemon has subscribed
// the stream (its response headers have arrived), so intents emitted after it returns
// are delivered. Read intents with Receive; cancel ctx to stop.
func (c *Client) WatchIntents(ctx context.Context) (*connect.ServerStreamForClient[v1.UiIntent], error) {
	stream, err := c.UI.WatchIntents(ctx, connect.NewRequest(&v1.WatchIntentsRequest{}))
	if err != nil {
		return nil, fmt.Errorf("watch intents: %w", err)
	}
	stream.ResponseHeader() // blocks until the server has flushed headers
	return stream, nil
}

// InvokeCommand calls CommandService.Invoke. Errors wrap the *connect.Error, so
// connect.CodeOf and errors.As work on them.
func (c *Client) InvokeCommand(ctx context.Context, name string, uctx *v1.UiContext, args map[string]string) (*v1.InvokeCommandResponse, error) {
	res, err := c.Command.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{
		Name: name, Context: uctx, Args: args,
	}))
	if err != nil {
		return nil, fmt.Errorf("invoke %s: %w", name, err)
	}
	return res.Msg, nil
}
