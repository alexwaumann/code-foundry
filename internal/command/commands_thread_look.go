package command

import (
	"context"
	"fmt"
	"slices"

	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// thread.look (docs/notes/waiting-thread-look.md): a thread asks the user to look at it.
// A thread waiting on its subscriptions sorts under Working, where the user rarely looks;
// this is its one quiet way to be seen without a status change. It posts a bell
// notification naming the thread (level warning, time-sensitive, so the row's mark and the
// bell take the attention tone) under SourceCommand with the fixed key
// notification.LookKey(thread): one per thread, a second post replaces the first in place.
// The app decides whether it is needed: with the thread's own tab open in the space the
// user's window shows, nothing is posted. The daemon withdraws it when the user sees the
// thread or the thread's turn ends needing them (internal/daemon/thread_look.go).

// ThreadLookDeps are what thread.look uses. A nil Notes registers it failing with
// Unimplemented; a nil Layout never knows what is on screen, so it always posts.
type ThreadLookDeps struct {
	Notes  notification.Store
	Layout layoutstore.Store
}

// ThreadLookView is thread.look's JSON. Posted is false when nothing was posted: Reason
// says why ("on_screen"), or the request was withdrawn (Withdrawn).
type ThreadLookView struct {
	Posted       bool              `json:"posted"`
	Reason       string            `json:"reason,omitempty"`
	Outcome      string            `json:"outcome,omitempty"`
	Withdrawn    bool              `json:"withdrawn,omitempty"`
	Notification *NotificationView `json:"notification,omitempty"`
}

// ThreadOnScreen reports whether thread id's own tab is open in the space the user's window
// shows, and whether that can be known: not before a window has loaded the layout (the
// first-load import has not run), nor without a layout.
func ThreadOnScreen(snap *layoutstore.Snapshot, id string) (onScreen, known bool) {
	if snap == nil || snap.State == nil || !snap.LegacyImported {
		return false, false
	}
	sp := snap.State.ThreadTabSpace(id)
	return sp != "" && sp == snap.State.CurrentSpace, true
}

// LookPost is the notification thread.look posts for thread id.
func LookPost(id, title, body string) notification.Post {
	return notification.Post{Source: notification.SourceCommand, Key: notification.LookKey(id), Level: notification.LevelWarning,
		TimeSensitive: true, Title: title, Body: body, ThreadID: id}
}

// RegisterThreadLook registers thread.look.
func RegisterThreadLook(r *Registry, d ThreadLookDeps) error {
	s := d.Notes
	if s == nil {
		s = noNotifications{}
	}
	return r.Register(Command{
		Name: "thread.look",
		Page: PageState,
		// Told to a waiting thread by thread.subscribe's reply, when it matters (index_test.go).
		NoIndex:   true,
		NoPalette: true,
		Title:     "Ask the User to Look",
		Description: "Ask the user to look at this thread while it waits, without changing its status: " +
			"one bell notification naming it, replaced by the next. Skipped when the thread is on screen in the user's space.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "title", Type: String, Positional: true, Rest: true,
				Description: fmt.Sprintf("What to look at, one line of at most %d characters (several words need no quotes)", notification.MaxTitle)},
			{Name: "body", Type: String, Description: fmt.Sprintf("More detail, at most %d characters", notification.MaxBody)},
			{Name: "id", Type: String, Required: true, Context: ContextThread, ID: ThreadID,
				Description: "The thread asking (default: the thread this runs in)" + IDHelp},
			{Name: "withdraw", Type: Bool, Description: "Take the request back"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			id := a.String("id")
			if a.Bool("withdraw") {
				if a.String("title") != "" || a.String("body") != "" {
					return Result{}, InvalidArg("withdraw", "takes no title or body")
				}
				return lookWithdraw(ctx, s, id)
			}
			if a.String("title") == "" {
				return Result{}, InvalidArg("title", "say what the user should look at")
			}
			var snap *layoutstore.Snapshot
			if d.Layout != nil {
				snap = d.Layout.Snapshot()
			}
			if on, _ := ThreadOnScreen(snap, id); on {
				return Result{Message: "not needed: thread " + id + " is on screen in the space the user's window shows; nothing was posted",
					JSON: ThreadLookView{Reason: "on_screen"}}, nil
			}
			res, err := s.Post(ctx, LookPost(id, a.String("title"), a.String("body")))
			if err != nil {
				return Result{}, notificationErr(err, "title")
			}
			v := notificationView(res.Notification)
			return Result{Message: lookMessage(res), JSON: ThreadLookView{Posted: true, Outcome: string(res.Outcome), Notification: &v}}, nil
		},
	})
}

// lookMessage says what a post did.
func lookMessage(res notification.PostResult) string {
	n := res.Notification
	switch {
	case res.Outcome == notification.OutcomeUpdated:
		return "updated the request to look in place (" + n.ID + ")"
	case res.Outcome == notification.OutcomeUnchanged && n.State == notification.StateActive:
		return "already asking the user to look with these words (" + n.ID + ")"
	case res.Outcome == notification.OutcomeUnchanged:
		return "the user " + string(n.State) + " this request already (" + n.ID + "); new words ask again"
	}
	return "asked the user to look: the bell and this thread's row show it until they open the thread (" + n.ID + ")"
}

// lookWithdraw takes thread id's request back.
func lookWithdraw(ctx context.Context, s notification.Store, id string) (Result, error) {
	key := notification.LookKey(id)
	if !slices.ContainsFunc(s.Snapshot().Notifications, func(n notification.Notification) bool {
		return n.Source == notification.SourceCommand && n.Key == key
	}) {
		return Result{Message: "thread " + id + " was not asking the user to look", JSON: ThreadLookView{}}, nil
	}
	n, err := s.Withdraw(ctx, notification.SourceCommand, key)
	if err != nil {
		return Result{}, notificationErr(err, "id")
	}
	v := notificationView(n)
	return Result{Message: "withdrew thread " + id + "'s request to look (" + n.ID + ")", JSON: ThreadLookView{Withdrawn: true, Notification: &v}}, nil
}
