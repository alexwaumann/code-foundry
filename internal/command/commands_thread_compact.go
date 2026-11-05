package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadCompact is thread.compact: /compact for a thread at its prompt, from the
// composer's chip and the thread info card's row (docs/notes/compact-button.md).
func threadCompact(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.compact",
		Title: "Compact Thread",
		Description: "Have Claude replace a thread's conversation with its summary (/compact). " +
			"A thread whose Claude is not running starts with it. Refused while the thread works or compacts.",
		Category: "Thread",
		Args:     []ArgSpec{positional(idArg)},
		When:     hasThread,
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			id := a.String("id")
			res, err := b.Compact(ctx, connect.NewRequest(&v1.CompactThreadRequest{ThreadId: id}))
			if err != nil {
				return Result{}, err
			}
			item := res.Msg.GetItem()
			msg := "compacting thread " + id
			if n := item.GetOrdinal(); n > 0 {
				msg += fmt.Sprintf(" (#%d); %s", n, sendNext(ctx, b, uctx.CallerThreadID, id, n))
			}
			return Result{Message: msg, JSON: item}, nil
		},
	}
}
