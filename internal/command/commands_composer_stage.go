package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ComposerStageResult is composer.stage's JSON result.
type ComposerStageResult struct {
	// Windows and Receivers are EmitResult's: the app windows connected and every stream
	// that received the intent (0 and 0 when nothing was sent).
	Windows   int    `json:"windows"`
	Receivers int    `json:"receivers"`
	Thread    string `json:"thread"`
	// Staged: a window showed the thread when the intent went out, so the text is in its
	// composer. False: no window shows the thread and nothing was sent.
	Staged bool `json:"staged"`
}

// message is composer.stage's text: "windows=1 thread=s-…", or that no window shows the
// thread.
func (r ComposerStageResult) message() string {
	if !r.Staged {
		return fmt.Sprintf("no app window shows thread %s: nothing was staged", r.Thread)
	}
	return fmt.Sprintf("windows=%d thread=%s", r.Windows, r.Thread)
}

// composerStageCommand is composer.stage: text in a thread's composer, not sent
// (UiIntent.StageComposer). For pages (cf.run from a page shown in a thread) and agents,
// so it is not in the palette. Only a window that shows the thread takes it, so the
// daemon sends nothing when no window does (ViewDeps.Viewed) and says so, exit 0: there
// was nothing wrong with the call.
func (d ViewDeps) composerStageCommand() Command {
	return Command{
		Name:      "composer.stage",
		NoPalette: true,
		Title:     "Put Text in Composer",
		Description: "Put text in a thread's composer without sending it, in every app window that shows the thread, and focus its prompt: " +
			"it replaces an empty draft, else goes on a new line after it. The user reads, edits and sends it.",
		Category:     "View",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "text", Type: String, Required: true, Positional: true, Description: "The text to put in the composer"},
			{
				Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
				Description: "Thread whose composer gets the text (default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected one)" + IDHelp,
			},
		},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			text, id := a.String("text"), a.String("thread")
			if strings.TrimSpace(text) == "" {
				return Result{}, InvalidArg("text", "is empty")
			}
			if id == "" {
				return Result{}, InvalidArg("thread", "needs a thread (--thread, or run it inside a thread)")
			}
			if d.Thread != nil {
				if _, err := d.Thread.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id})); err != nil {
					return Result{}, err
				}
			}
			out := ComposerStageResult{Thread: id, Windows: d.Emitter.Windows()}
			if out.Windows > 0 && (d.Viewed == nil || d.Viewed(id)) {
				sent := EmitTo(d.Emitter, &v1.UiIntent{Intent: &v1.UiIntent_StageComposer_{StageComposer: &v1.UiIntent_StageComposer{ThreadId: id, Text: text}}})
				out.Windows, out.Receivers, out.Staged = sent.Windows, sent.Receivers, true
			}
			res := Result{JSON: out}
			if uctx.ActiveView == "" {
				res.Message = out.message()
			}
			return res, nil
		},
	}
}
