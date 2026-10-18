package main

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/guide"
)

// runGuide is the guide verb: a Markdown guide for an agent running inside a thread
// (the code-foundry-orchestrate skill every thread gets points at it). It
// is documentation, like --help, so a local verb rather than a registry command, and it
// is generated from CommandService.List (the palette's source) at every run, so it
// never drifts from the commands; internal/guide renders it. See docs/notes/agents-5-cli.md.
func runGuide(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("guide")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	c, err := cl.connect(ctx)
	if err != nil {
		return err
	}
	cmds, err := c.ListCommands(ctx, nil, true)
	if err != nil {
		return err
	}
	guide.Write(cl.stdout, cmds, cl.threadEnv())
	return nil
}
