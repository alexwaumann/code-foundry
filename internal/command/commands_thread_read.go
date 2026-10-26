package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.read (docs/notes/agents-5-cli.md): a lighter thread.items for an agent reading
// another thread. The daemon pages (ListThreadItemsRequest.query), so a long
// conversation is not sent whole. A separate command rather than thread.items with more
// args: its defaults differ (the last 20 items, not all) and so does its JSON (a page
// with next_since, not the snapshot with pending requests and agents).

// ThreadItemRoles are thread.read's role values.
var ThreadItemRoles = []string{"user", "assistant", "tool", "note", "wake"}

var threadItemRoles = map[string]v1.ThreadItemRole{
	"user":      v1.ThreadItemRole_THREAD_ITEM_ROLE_USER,
	"assistant": v1.ThreadItemRole_THREAD_ITEM_ROLE_ASSISTANT,
	"tool":      v1.ThreadItemRole_THREAD_ITEM_ROLE_TOOL,
	"note":      v1.ThreadItemRole_THREAD_ITEM_ROLE_NOTE,
	"wake":      v1.ThreadItemRole_THREAD_ITEM_ROLE_WAKE,
}

func threadRead(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:      "thread.read",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "Read Thread",
		Description: "Print a thread's latest items as a readable log, like thread.items: the last 20, or with since the ones " +
			"after an item (oldest first, at most last). --json: {items, nextSince, more}.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			idArg,
			{Name: "last", Type: Int, Default: "20", Description: "How many items: the last ones, or with since the first ones after it (0: all)"},
			{Name: "since", Type: String, Description: "Only items after this one: an item id (nextSince of a previous read) or its ordinal (#N in the log)"},
			{Name: "role", Type: Enum, Enum: ThreadItemRoles, Description: "Only items of this role: user, assistant (Claude's text), tool (calls, permission requests, questions), note, or wake"},
			{Name: "full", Type: Bool, Description: "Print whole texts, tool inputs and outputs instead of one line each"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.Int("last") < 0 {
				return Result{}, InvalidArg("last", "last must be 0 (all) or more, not %d", a.Int("last"))
			}
			id, since := a.String("id"), a.String("since")
			res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: id, Query: &v1.ThreadItemsQuery{
				Last: int32(a.Int("last")), Since: since, Role: threadItemRoles[a.String("role")],
			}}))
			if r, ok := removedFrom(err); ok {
				return removedWaitResult(r, ""), nil // exit 1, like thread.get and thread.wait
			}
			if err != nil {
				return Result{}, err
			}
			p := res.Msg.GetPage()
			msg := FormatThreadItems(&v1.ThreadItemsSnapshot{ThreadId: id, Items: p.GetItems()}, a.Bool("full"))
			switch {
			case len(p.GetItems()) == 0 && since != "":
				msg = "(nothing after " + since + " yet)"
			case p.GetMore():
				msg += fmt.Sprintf("\n(more: --since %s reads on)", p.GetNextSince())
			}
			return Result{Message: msg, JSON: p}, nil
		},
	}
}
