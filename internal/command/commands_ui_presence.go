package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/presence"
)

// PresenceDeps back ui.presence: whether the user is looking at the app, and at a
// thread (docs/notes/control-1-thread-scoped-views.md). A nil field reads as no GUI.
type PresenceDeps struct {
	// Presence is the daemon's presence now (presence.Tracker.Current, which the GUI
	// windows' visibility and focus write).
	Presence func() presence.State
	// Windows is the number of GUI windows connected now.
	Windows func() int
	// Viewed reports whether a GUI view shows a thread now (it holds the thread's
	// WatchThread stream).
	Viewed func(threadID string) bool
	// Thread checks that the thread asked about exists (ThreadService.Get), like the
	// panel verbs. Nil: not checked. all.Register sets it to the thread backend.
	Thread ThreadGetter
}

// PresenceResult is ui.presence's JSON result.
type PresenceResult struct {
	// State is presence.State.String(): "none" (no window), "background" (every window
	// hidden: minimized, on another desktop or fully covered by other windows),
	// "foreground" (a window is at least partly visible but none has focus: another app
	// is in front), "foreground+attended" (a visible window has focus).
	State string `json:"state"`
	// Attended: a visible window has focus; the user is looking at the app.
	Attended bool `json:"attended"`
	// Windows is the number of GUI windows connected.
	Windows int `json:"windows"`
	// Thread is the thread Viewed is about; omitted with none.
	Thread string `json:"thread,omitempty"`
	// Viewed: a window has Thread open now, attended or not, on screen or not (see State).
	Viewed bool `json:"viewed"`
}

// presenceWords say what each presence kind means, for the text output.
var presenceWords = map[presence.Kind]string{
	presence.None:       "no app window is open",
	presence.Background: "the app's windows are hidden, minimized or covered",
	presence.Foreground: "an app window is visible, another app is in front",
}

// RegisterPresence registers ui.presence, which reports whether the user is looking at
// the app and whether a window shows the caller's thread: a thread's model reads it to
// decide whether to mention that the window is in the background, not whether to open
// something in its own side panel (control-7-skill-routing).
func RegisterPresence(r *Registry, d PresenceDeps) error {
	return r.Register(Command{
		Name:  "ui.presence",
		Title: "Show App Presence",
		Description: "Report whether the user is looking at the app (attended: a visible window has focus), " +
			"how many windows are open, and whether one shows a thread (viewed; default: the thread this runs in).",
		Category:     "View",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID, Description: "Thread to report viewed for (default: the thread this runs in, $CODE_FOUNDRY_THREAD)" + IDHelp},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if id := a.String("thread"); id != "" && d.Thread != nil {
				if _, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id})); err != nil {
					return Result{}, err
				}
			}
			var st presence.State
			if d.Presence != nil {
				st = d.Presence()
			}
			res := PresenceResult{State: st.String(), Attended: st.Attended, Thread: a.String("thread")}
			if d.Windows != nil {
				res.Windows = d.Windows()
			}
			if res.Thread != "" && d.Viewed != nil {
				res.Viewed = d.Viewed(res.Thread)
			}
			return Result{Message: formatPresence(st, res), JSON: res}, nil
		},
	})
}

// formatPresence is ui.presence's text output:
//
//	presence: foreground+attended (the user is looking at the app)
//	windows: 1
//	thread s-…: viewed (a window shows it)
//
// A thread viewed while no window is visible (background) is open in a window the user
// cannot see.
func formatPresence(st presence.State, r PresenceResult) string {
	what := presenceWords[st.Kind]
	if st.Attended {
		what = "the user is looking at the app"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "presence: %s (%s)\nwindows: %d", r.State, what, r.Windows)
	switch {
	case r.Thread == "":
	case r.Viewed && st.Kind == presence.Foreground:
		fmt.Fprintf(&b, "\nthread %s: viewed (a window shows it)", r.Thread)
	case r.Viewed:
		fmt.Fprintf(&b, "\nthread %s: viewed (a window has it open; the window is hidden or covered)", r.Thread)
	default:
		fmt.Fprintf(&b, "\nthread %s: not viewed (no window shows it)", r.Thread)
	}
	return b.String()
}
