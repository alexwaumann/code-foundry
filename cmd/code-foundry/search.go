package main

import (
	"context"
	"fmt"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// presentAgentSearch starts an agent search for vals["question"] and follows it: steps
// to stderr (the current one redrawn in place on a terminal), each verified hit to stdout
// as it is accepted, then the answer. An interrupt (^C) stops the search.
func presentAgentSearch(ctx context.Context, cl *cli, c *client.Client, vals map[string]string, asJSON bool) error {
	const name = "search.agent"
	res, err := c.Search.StartAgent(ctx, connect.NewRequest(&v1.StartAgentSearchRequest{Question: vals["question"]}))
	if err != nil {
		return cl.invokeFailed(name, err)
	}
	id := res.Msg.GetEntry().GetId()
	stream, err := c.Search.Watch(ctx, connect.NewRequest(&v1.WatchSearchRequest{Id: id}))
	if err != nil {
		return cl.invokeFailed(name, err)
	}
	defer func() { _ = stream.Close() }()
	out := progressPrinter{w: cl.stderr, live: cl.interactive != nil && cl.interactive()}
	if !asJSON {
		out.print("searching… ("+id+")", true)
	}
	shownHits := map[int32]bool{}
	showHit := func(h *v1.AgentSearchHit) {
		if asJSON || shownHits[h.GetN()] {
			return
		}
		shownHits[h.GetN()] = true
		out.end()
		fmt.Fprintln(cl.stdout, command.FormatSearchHit(h))
	}
	shownSteps := map[int32]bool{}
	showStep := func(s *v1.AgentSearchStep) {
		if asJSON || shownSteps[s.GetIndex()] {
			return
		}
		if s.GetDone() {
			shownSteps[s.GetIndex()] = true
		}
		out.print(s.GetText(), !s.GetDone())
	}
	for stream.Receive() {
		switch ev := stream.Msg().GetEvent().(type) {
		case *v1.SearchWatchEvent_Snapshot:
			for _, s := range ev.Snapshot.GetSteps() {
				showStep(s)
			}
			for _, h := range ev.Snapshot.GetHits() {
				showHit(h)
			}
		case *v1.SearchWatchEvent_Step:
			showStep(ev.Step)
		case *v1.SearchWatchEvent_Hit:
			showHit(ev.Hit)
		}
	}
	out.end()
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			// ^C: the search stops with the CLI (the GUI's keeps running without it).
			stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			_, _ = c.Search.Stop(stopCtx, connect.NewRequest(&v1.StopSearchRequest{Id: id}))
			fmt.Fprintln(cl.stderr, "stopped "+id)
			return errReported
		}
		return cl.invokeFailed(name, err)
	}
	got, err := c.Search.Get(ctx, connect.NewRequest(&v1.GetSearchRequest{Id: id}))
	if err != nil {
		return cl.invokeFailed(name, err)
	}
	e := got.Msg.GetEntry()
	if asJSON {
		b, err := protojson.Marshal(e)
		if err != nil {
			return fmt.Errorf("encode result: %w", err)
		}
		fmt.Fprintln(cl.stdout, string(b))
		return nil
	}
	for _, h := range e.GetHits() {
		showHit(h)
	}
	if len(shownHits) > 0 {
		fmt.Fprintln(cl.stdout)
	}
	if a := e.GetAnswer(); a != "" {
		fmt.Fprintln(cl.stdout, a)
	} else if len(e.GetHits()) == 0 {
		fmt.Fprintln(cl.stdout, "no verified hits")
	}
	summary := command.FormatSearchEntry(&v1.SearchEntry{Id: e.GetId(), Mode: e.GetMode(), Status: e.GetStatus(), DurationMs: e.GetDurationMs(),
		Searches: e.GetSearches(), ThreadsRead: e.GetThreadsRead(), CostUsd: e.GetCostUsd(), Error: e.GetError(), Hits: e.GetHits()}, time.Now())
	if i := firstLine(summary); i != "" {
		fmt.Fprintln(cl.stderr, i)
	}
	if e.GetStatus() == v1.SearchStatus_SEARCH_STATUS_FAILED {
		return errReported
	}
	if e.GetClaudeSessionId() != "" {
		fmt.Fprintln(cl.stderr, "Continue it as a thread: code-foundry search promote "+e.GetId())
	}
	return nil
}

func firstLine(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			return s[:i]
		}
	}
	return s
}
