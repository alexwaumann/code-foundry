package command

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.message.cancel and thread.message.resend (docs/notes/cancel-queued-messages.md):
// take back your own message Claude has not read (the queued bubble's and the not sent
// bubble's Cancel), and send a not sent one again (its Re-send). The daemon decides what
// can be taken back and refuses the rest with why (internal/store/thread cancel.go).

// MessageBackend is the slice of ThreadService thread.message.cancel and
// thread.message.resend need.
type MessageBackend interface {
	CancelMessage(context.Context, *connect.Request[v1.CancelThreadMessageRequest]) (*connect.Response[v1.CancelThreadMessageResponse], error)
	ResendMessage(context.Context, *connect.Request[v1.ResendThreadMessageRequest]) (*connect.Response[v1.ResendThreadMessageResponse], error)
}

// messageArg names the message: its item id, or #N as thread read prints it.
var messageArg = ArgSpec{Name: "message", Type: String, Required: true, Positional: true,
	Description: "The message: #N as thread read prints it, or its item id"}

func threadMessageCancel(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.message.cancel",
		Page:      PageDrives,
		NoPalette: true, // a message's own control: its bubble's Cancel
		// The user's own messages only: an agent's are another thread's (SentBy), so no
		// agent needs it (like thread.unread).
		NoIndex: true,
		Title:   "Cancel Message",
		Description: "Take back a message you sent that Claude has not read: one still queued (sent while Claude worked) leaves " +
			"Claude's queue and Claude never sees it; a not sent one (Claude stopped first, or an interrupt held it) just goes. " +
			"It leaves the conversation; its text is printed (the app puts it back in the composer). Refused when Claude already read it, " +
			"or for a message another thread sent or a wake.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{messageArg, idArg},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			item, err := messageItemID(ctx, b, id, a.String("message"))
			if err != nil {
				return Result{}, err
			}
			res, err := b.CancelMessage(ctx, connect.NewRequest(&v1.CancelThreadMessageRequest{ThreadId: id, ItemId: item}))
			if err != nil {
				return Result{}, err
			}
			it := res.Msg.GetItem()
			return Result{Message: fmt.Sprintf("cancelled #%d of thread %s; it said:\n%s", it.GetOrdinal(), id, it.GetUserMessage().GetText()), JSON: it}, nil
		},
	}
}

func threadMessageResend(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.message.resend",
		Page:      PageDrives,
		NoPalette: true, // a message's own control: its bubble's Re-send
		NoIndex:   true,
		Title:     "Re-send Message",
		Description: "Send a not sent message again (Claude stopped before it read it, or an interrupt held it): the same text, tags and " +
			"attachments go as a new message, like thread send (a stopped thread starts, a working one queues it), and the old one goes. " +
			"An attachment no longer staged is left out, and said so.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{messageArg, idArg},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			item, err := messageItemID(ctx, b, id, a.String("message"))
			if err != nil {
				return Result{}, err
			}
			res, err := b.ResendMessage(ctx, connect.NewRequest(&v1.ResendThreadMessageRequest{ThreadId: id, ItemId: item}))
			if err != nil {
				return Result{}, err
			}
			msg := fmt.Sprintf("sent again to thread %s as #%d", id, res.Msg.GetItem().GetOrdinal())
			if gone := res.Msg.GetGoneAttachments(); len(gone) > 0 {
				msg += "; without " + strings.Join(gone, ", ") + ": no longer staged"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

// messageItemID is ref's item id: ref itself, or the item whose ordinal #N (or N) names.
func messageItemID(ctx context.Context, b ThreadBackend, threadID, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	n, err := strconv.ParseInt(strings.TrimPrefix(ref, "#"), 10, 64)
	if err != nil || n <= 0 {
		return ref, nil
	}
	res, err := b.ListItems(ctx, connect.NewRequest(&v1.ListThreadItemsRequest{ThreadId: threadID}))
	if err != nil {
		return "", err
	}
	for _, it := range res.Msg.GetSnapshot().GetItems() {
		if it.GetOrdinal() == n {
			return it.GetId(), nil
		}
	}
	return "", connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s has no message #%d", threadID, n))
}
