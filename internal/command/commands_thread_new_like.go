package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadNewLike is thread.new-like, "New thread on this branch"
// (docs/notes/workspaces-v2-handoff.md §6): a new thread with the source thread's
// project set, branch, primary, workspace reference and mode, through
// CreateThreadRequest.like_thread_id (thread new --like). Only the prompt and the
// Claude options are new; project picks another primary among the source's checkouts.
// The GUI presents it as the composer prefilled from the thread.
func threadNewLike(r *Registry, b ThreadBackend, e Emitter) Command {
	return Command{
		Name:         "thread.new-like",
		Title:        "New thread on this branch",
		Description:  "Start a new thread with this thread's projects, branch, primary, workspace and mode (thread new --like).",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Positional: true, Context: ContextThread, ID: ThreadID, Description: "Thread id of the thread to copy" + IDHelp},
			{Name: "project", Type: String, Description: "Where it runs: one of its projects, or workspace (default: the thread's own)"},
			{Name: "model", Type: Enum, Enum: ThreadModels, Description: "As thread new's"},
			{Name: "effort", Type: Enum, Enum: ThreadEfforts, Description: "As thread new's"},
			{Name: "permission", Type: Enum, Enum: ThreadPermissions, Default: "auto", Description: "As thread new's"},
			{Name: "prompt", Type: String, FileOrStdin: true, Description: "The first message (@file, -: stdin)"},
			{Name: "composer-prompt", Type: String, Description: "The GUI composer's text of prompt with its tag tokens, kept on the first message for display (the GUI sets it)"},
			{Name: "attachments", Type: String, Description: "Comma-separated image or PDF paths from StageAttachment, appended to the prompt"},
			{Name: "name", Type: String, Description: "Thread name"},
			createdFocusArg,
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			req := &v1.CreateThreadRequest{
				LikeThreadId: a.String("id"), ProjectId: a.String("project"),
				Model: a.String("model"), Effort: a.String("effort"), Name: a.String("name"),
				InitialPrompt: a.String("prompt"), ComposerPrompt: a.String("composer-prompt"),
				PermissionMode: threadPermissionModes[a.String("permission")], Attachments: splitList(a.String("attachments")),
				// As thread.new: a model or effort from the settings' default, not chosen.
				ModelDefaulted:  a.String("model") != "" && !a.Given("model"),
				EffortDefaulted: a.String("effort") != "" && !a.Given("effort"),
			}
			res, err := b.Create(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			focusCreated(e, a, s.GetId())
			// Collision hints, never a refusal: the source thread works there too.
			return Result{Message: createdMessage(s, req, r.projectNamer(ctx)), JSON: s, Warnings: res.Msg.GetHints()}, nil
		},
	}
}
