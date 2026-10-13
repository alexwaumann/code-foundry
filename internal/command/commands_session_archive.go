package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// sessionArchive is session.archive: archive a thread (Claude closed, its shells
// removed, unpinned, listed apart) or unarchive it (back in the thread list, still
// disconnected). Without --archived it toggles. Archiving asks for confirmation only
// while Claude is working or waiting on the user's answer, since it ends that turn;
// idle, finished, errored and disconnected threads archive at once, and unarchiving
// never asks. See docs/notes/archive-threads-1-daemon.md.
func sessionArchive(b SessionBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "session.archive",
		Title: "Archive or Unarchive Thread",
		Description: "Archive a thread: Claude is closed, its terminals are removed and it is unpinned and listed apart. " +
			"Unarchive puts it back in the thread list, still disconnected. Without archived, toggles. " +
			"Reconnecting, pinning or sending a message unarchives a thread too.",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "archived", Type: Bool, Description: "Archive (true) or unarchive (false); default: the opposite of now"},
		},
		When:    hasSession,
		Confirm: "Archive thread {id}? Claude is still working; archiving ends the turn.",
		ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
			return archiveConfirm(ctx, b, a) != ""
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return archiveConfirm(ctx, b, a)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			archived := a.Bool("archived")
			if !a.Has("archived") {
				cur, err := b.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				archived = cur.Msg.GetSession().GetArchivedAt() == nil
			}
			res, err := b.Archive(ctx, connect.NewRequest(&v1.ArchiveSessionRequest{Id: id, Archived: archived}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetSession()
			verb := "unarchived"
			if s.GetArchivedAt() != nil {
				verb = "archived"
			}
			return Result{Message: verb + " thread " + sessionLabel(s), JSON: s}, nil
		},
	}
}

// archiveConfirm is session.archive's confirmation for this call, or "" when it needs
// none: unarchiving, or archiving a thread that is not mid-turn (archiveInterrupts).
// An unknown thread needs none either: Run reports it.
func archiveConfirm(ctx context.Context, b SessionBackend, a Args) string {
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: a.String("id")}))
	if err != nil {
		return ""
	}
	s := res.Msg.GetSession()
	archiving := s.GetArchivedAt() == nil
	if a.Has("archived") {
		archiving = a.Bool("archived")
	}
	if !archiving {
		return ""
	}
	why := archiveInterrupts(s)
	if why == "" {
		return ""
	}
	name := s.GetName()
	if name == "" {
		name = s.GetId()
	}
	return "Archive thread " + name + "? " + why + "; archiving ends the turn."
}

// archiveInterrupts says what archiving s would cut off: "Claude is waiting on your
// answer" while a permission request or question is pending (status reasons
// "permission: ..." and "question: ...", stream_status.go), "Claude is still working"
// while it starts or runs a turn; "" otherwise (idle, a finished or failed turn,
// closing, disconnected).
func archiveInterrupts(s *v1.Session) string {
	if st := s.GetState(); st == v1.SessionState_SESSION_STATE_STARTING {
		return "Claude is still working"
	} else if st != v1.SessionState_SESSION_STATE_CONNECTED {
		return ""
	}
	switch s.GetStatus() {
	case v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION:
		if r := s.GetStatusReason(); strings.HasPrefix(r, "permission:") || strings.HasPrefix(r, "question:") {
			return "Claude is waiting on your answer"
		}
	case v1.SessionStatus_SESSION_STATUS_BUSY:
		return "Claude is still working"
	}
	return ""
}
