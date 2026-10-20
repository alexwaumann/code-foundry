package main

import (
	"context"
	"errors"
	"flag"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/guide"
)

// runGuide is the guide verb: a Markdown guide for an agent running inside a thread
// (the code-foundry-orchestrate skill every thread gets points at it). It
// is documentation, like --help, so a local verb rather than a registry command, and it
// is generated from CommandService.List (the palette's source) at every run, so it
// never drifts from the commands; internal/guide renders it. See docs/notes/agents-5-cli.md.
//
// `code-foundry guide` is the intro, the conventions and the thread commands, and names
// the other categories' topics; `code-foundry guide <topic>` prints one
// (docs/notes/hidden-children-1-daemon.md: the whole guide outgrew what an agent's Bash
// tool reads at once).
func runGuide(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("guide")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return quietHelp(errHelp)
		}
		return quietHelp(errUsage)
	}
	if fs.NArg() > 1 {
		fmt.Fprintf(cl.stderr, "guide: unexpected arguments %v (one topic at most)\n", fs.Args()[1:])
		return quietHelp(errUsage)
	}
	c, err := cl.connect(ctx)
	if err != nil {
		return err
	}
	cmds, err := c.ListCommands(ctx, nil, true)
	if err != nil {
		return err
	}
	if fs.NArg() == 1 {
		if err := guide.WriteTopic(cl.stdout, cmds, fs.Arg(0)); err != nil {
			fmt.Fprintf(cl.stderr, "guide: %v\n", err)
			return errUsage
		}
		return nil
	}
	guide.Write(cl.stdout, cmds, cl.threadEnv())
	return nil
}
