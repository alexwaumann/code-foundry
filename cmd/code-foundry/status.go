package main

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/client"
	"github.com/awaumann/code-foundry/internal/paths"
	"github.com/awaumann/code-foundry/internal/version"
)

func runStatus(ctx context.Context, cl *cli, args []string) error {
	if err := cl.parseFlags(cl.newFlagSet("status"), args); err != nil {
		return quietHelp(err)
	}
	p, err := paths.Resolve()
	if err != nil {
		return err
	}
	c, err := cl.connect(ctx)
	if err != nil {
		return err
	}
	ping, err := c.Ping(ctx)
	if err != nil {
		return err
	}
	ver, err := c.Health.Version(ctx, connect.NewRequest(&v1.VersionRequest{}))
	if err != nil {
		return fmt.Errorf("daemon version: %w", err)
	}
	loopback := "unavailable"
	if ep, err := client.ReadEndpoint(p); err == nil {
		loopback = ep.BaseURL
	}

	w := tabwriter.NewWriter(cl.stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintf(w, "pid\t%d\n", ping.GetPid())
	fmt.Fprintf(w, "version\t%s\n", formatVersion(ver.Msg.GetVersion(), ver.Msg.GetCommit()))
	fmt.Fprintf(w, "uptime\t%s\n", ping.GetUptime().AsDuration().Round(time.Second))
	fmt.Fprintf(w, "socket\t%s\n", p.Socket())
	fmt.Fprintf(w, "loopback\t%s\n", loopback)
	fmt.Fprintf(w, "home\t%s\n", p.Home())
	return w.Flush()
}

func runVersion(_ context.Context, cl *cli, args []string) error {
	if err := cl.parseFlags(cl.newFlagSet("version"), args); err != nil {
		return quietHelp(err)
	}
	v := version.Get()
	fmt.Fprintf(cl.stdout, "code-foundry %s %s\n", formatVersion(v.Version, v.Commit), v.GoVersion)
	return nil
}

func formatVersion(v, commit string) string {
	if base, dirty := strings.CutSuffix(commit, "-dirty"); len(base) > 12 {
		commit = base[:12]
		if dirty {
			commit += "-dirty"
		}
	}
	if commit == "" {
		return v
	}
	return v + " (" + commit + ")"
}
