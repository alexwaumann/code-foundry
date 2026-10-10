package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// sessionPin is session.pin: pin a thread to the top of the GUI's thread list, or unpin
// it. Without --pinned it toggles the thread's current pin.
func sessionPin(b SessionBackend, idArg ArgSpec) Command {
	return Command{
		Name:        "session.pin",
		Title:       "Pin or Unpin Thread",
		Description: "Pin a thread to the top of the thread list, or unpin it. Without pinned, toggles the current pin.",
		Category:    "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "pinned", Type: Bool, Description: "Pin (true) or unpin (false); default: the opposite of now"},
		},
		When: hasSession,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			pinned := a.Bool("pinned")
			if !a.Has("pinned") {
				cur, err := b.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				pinned = !cur.Msg.GetSession().GetPinned()
			}
			res, err := b.Pin(ctx, connect.NewRequest(&v1.PinSessionRequest{Id: id, Pinned: pinned}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetSession()
			verb := "unpinned"
			if s.GetPinned() {
				verb = "pinned"
			}
			return Result{Message: verb + " thread " + sessionLabel(s), JSON: s}, nil
		},
	}
}
