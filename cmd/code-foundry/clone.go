package main

import (
	"context"
	"errors"
	"fmt"
	"io"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// cliPresenter runs a daemon command the CLI shows its own way, after the generated
// verb has parsed and validated its flags. The command itself still comes from the
// registry (name, args, help); only the presentation differs, like the GUI's presenters
// (gui/frontend/src/keys/bindings.ts).
type cliPresenter func(ctx context.Context, cl *cli, c *client.Client, vals map[string]string, asJSON bool) error

// cliPresenters maps command names to their CLI presentation.
var cliPresenters = map[string]cliPresenter{
	// repo.clone streams RepoService.Clone so the clone's progress shows as it runs;
	// Invoke would only answer once it is done.
	"repo.clone": presentClone,
}

// presentClone clones vals["repo"] (owner/repo or an https://github.com URL), printing
// gh's progress to stderr and the result to stdout.
func presentClone(ctx context.Context, cl *cli, c *client.Client, vals map[string]string, asJSON bool) error {
	const name = "repo.clone"
	owner, repoName, err := gh.ParseRepoRef(vals["repo"])
	if err != nil {
		fmt.Fprintf(cl.stderr, "code-foundry %s: %s\n", name, err)
		fmt.Fprintf(cl.stderr, "Run `code-foundry help %s` for usage.\n", name)
		return errUsage
	}
	stream, err := c.Repo.Clone(ctx, connect.NewRequest(&v1.CloneRepoRequest{Owner: owner, Name: repoName}))
	if err != nil {
		return cl.invokeFailed(name, err)
	}
	defer func() { _ = stream.Close() }()
	out := progressPrinter{w: cl.stderr, live: cl.interactive != nil && cl.interactive()}
	var repo *v1.Repo
	for stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *v1.CloneRepoEvent_Progress:
			out.print(ev.Progress.GetLine(), ev.Progress.GetTransient())
		case *v1.CloneRepoEvent_Repo:
			repo = ev.Repo
		}
	}
	out.end()
	if err := stream.Err(); err != nil {
		return cl.invokeFailed(name, err)
	}
	if repo == nil {
		return errors.New(name + ": the clone ended without a project")
	}
	if asJSON {
		b, err := protojson.Marshal(repo)
		if err != nil {
			return fmt.Errorf("encode result: %w", err)
		}
		fmt.Fprintln(cl.stdout, string(b))
		return nil
	}
	fmt.Fprintf(cl.stdout, "cloned %s into %s (%s)\n", repo.GetName(), repo.GetPath(), repo.GetId())
	return nil
}

// progressPrinter writes clone progress. On a terminal (live) a transient line is
// redrawn in place; elsewhere transient lines are skipped, so logs get only final
// lines.
type progressPrinter struct {
	w    io.Writer
	live bool
	open bool // a transient line is on screen without its newline
}

func (p *progressPrinter) print(line string, transient bool) {
	switch {
	case transient && !p.live:
		return
	case transient:
		fmt.Fprintf(p.w, "\r%s\x1b[K", line)
		p.open = true
	case p.open:
		fmt.Fprintf(p.w, "\r%s\x1b[K\n", line)
		p.open = false
	default:
		fmt.Fprintln(p.w, line)
	}
}

// end finishes a transient line left on screen.
func (p *progressPrinter) end() {
	if p.open {
		fmt.Fprintln(p.w)
		p.open = false
	}
}
