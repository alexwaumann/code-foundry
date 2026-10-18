package main

import (
	"context"
	"fmt"
	"strconv"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// cliFollower keeps printing a plugin's log after a command succeeded (its result is
// printed first): plugin logs --follow, and plugin dev, which follows by default when
// run from a terminal (--follow=false: do not; an agent's CLI never follows unasked).
// The command still comes from the registry; only the CLI streams
// (PluginService.FollowLogs), because a command's Result is one-shot.
type cliFollower struct {
	// onTerminal: follow without --follow when stdin and stderr are a terminal.
	onTerminal bool
	// target names the plugin and how many earlier lines to print first.
	target func(vals map[string]string, res *v1.InvokeCommandResponse) (name string, lines int32, ok bool)
	// follow, when set, replaces following the plugin's log (plugin surface --watch).
	follow func(ctx context.Context, cl *cli, c *client.Client, res *v1.InvokeCommandResponse) error
}

var cliFollowers = map[string]cliFollower{
	"plugin.logs": {target: func(vals map[string]string, _ *v1.InvokeCommandResponse) (string, int32, bool) {
		n, err := strconv.Atoi(vals["lines"])
		if err != nil {
			n = 50
		}
		return vals["name"], int32(n), true
	}},
	"plugin.surface": {
		target: func(_ map[string]string, _ *v1.InvokeCommandResponse) (string, int32, bool) { return "", 0, true },
		follow: watchSurface,
	},
	"plugin.dev": {onTerminal: true, target: func(_ map[string]string, res *v1.InvokeCommandResponse) (string, int32, bool) {
		var dev v1.DevPluginResponse
		if err := protojson.Unmarshal([]byte(res.GetResultJson()), &dev); err != nil || dev.GetPlugin().GetName() == "" {
			return "", 0, false
		}
		return dev.GetPlugin().GetName(), 20, true
	}},
}

// wantsFollow: --follow (plugin surface: --watch) given (true), or not given and the follower follows on a
// terminal and this is one.
func (cl *cli) wantsFollow(f cliFollower, flags []*argFlag) bool {
	for _, a := range flags {
		if (a.spec.GetName() == "follow" || a.spec.GetName() == "watch") && a.set {
			b, err := strconv.ParseBool(a.value)
			return err == nil && b
		}
	}
	return f.onTerminal && cl.interactive != nil && cl.interactive()
}

// watchSurface prints a surface instance's updates (PluginService.WatchSurface) until
// ctx ends: plugin surface --watch, after the first view was printed.
func watchSurface(ctx context.Context, cl *cli, c *client.Client, res *v1.InvokeCommandResponse) error {
	var got v1.GetSurfaceResponse
	if err := protojson.Unmarshal([]byte(res.GetResultJson()), &got); err != nil || got.GetState().GetInstance() == "" {
		return fmt.Errorf("plugin.surface: no instance to watch")
	}
	inst := got.GetState().GetInstance()
	stream, err := c.Plugin.WatchSurface(ctx, connect.NewRequest(&v1.WatchSurfaceRequest{Ref: &v1.SurfaceRef{Instance: inst}}))
	if err != nil {
		return cl.invokeFailed("plugin.surface", err)
	}
	defer func() { _ = stream.Close() }()
	fmt.Fprintf(cl.stderr, "watching %s (Ctrl-C to stop)\n", inst)
	for stream.Receive() {
		if line := command.FormatSurfaceUpdate(stream.Msg()); line != "" {
			fmt.Fprintln(cl.stdout, line)
		}
	}
	if err := stream.Err(); err != nil && ctx.Err() == nil {
		return cl.invokeFailed("plugin.surface", err)
	}
	return nil
}

// followPluginLog prints name's log, the last lines first, until ctx ends (Ctrl-C).
func (cl *cli) followPluginLog(ctx context.Context, c *client.Client, name string, lines int32) error {
	stream, err := c.Plugin.FollowLogs(ctx, connect.NewRequest(&v1.FollowPluginLogsRequest{Name: name, Lines: lines}))
	if err != nil {
		return cl.invokeFailed("plugin.logs", err)
	}
	defer func() { _ = stream.Close() }()
	fmt.Fprintf(cl.stderr, "following the log of plugin %s (Ctrl-C to stop)\n", name)
	for stream.Receive() {
		fmt.Fprintln(cl.stdout, command.FormatPluginLogLine(stream.Msg()))
	}
	if err := stream.Err(); err != nil && ctx.Err() == nil {
		return cl.invokeFailed("plugin.logs", err)
	}
	return nil
}
