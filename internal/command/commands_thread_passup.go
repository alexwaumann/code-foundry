package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.pass-up (docs/notes/pass-up-question.md): a lead passes a worker's question up
// to the user without answering it and without stopping. The question becomes the lead's
// ask in Needs you; the user's answer goes straight to the worker and the lead gets a wake
// saying what it was. A worker's question is the lead's to answer: this is only for a
// product decision the lead genuinely does not know, so the help says so in the agreed
// words and no more.
//
// The name: "pass up" is what the user called it, and it says the direction (to the user,
// above the lead) and that the lead hands it on rather than answering. "escalate" reads as
// a problem, "forward" names no direction, "ask-user" would read as the lead's own question.

// PassUpBackend is the slice of ThreadService thread.pass-up needs.
type PassUpBackend interface {
	PassUp(context.Context, *connect.Request[v1.PassUpQuestionRequest]) (*connect.Response[v1.PassUpQuestionResponse], error)
}

// PassUpRule is what a lead is told about a worker's question, in the skill, the help and
// the texts a lead reads when a worker asks.
const PassUpRule = "A worker's question is yours to answer. Answer it when you know the answer or can infer what the user wants. " +
	"Pass it up (thread pass-up) only for a product decision you are genuinely unsure of; then keep working. " +
	"Never pass up a permission prompt: approve or deny it yourself."

func threadPassUpCmd(b ThreadBackend) Command {
	return Command{
		Name:      "thread.pass-up",
		Page:      PageDrives,
		NoPalette: true,
		Title:     "Pass a Question Up to the User",
		Description: "Pass a worker's question up to the user without answering it: its pending question (its question tool), " +
			"else its thread ask you have not answered. The user sees it as your question; their answer goes straight to the worker, " +
			"and you are woken with it. " + PassUpRule,
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "id", Type: String, Required: true, Positional: true, ID: ThreadID, Description: "The worker whose question goes up" + IDHelp},
			{Name: "request", Type: String, Description: "Its pending question's request id (default: its oldest pending question, else its thread ask)"},
			{Name: "by", Type: String, DefaultToThreadEnv: true, ID: ThreadID,
				Description: "The lead passing it up, a thread above the worker (the CLI sets it from $CODE_FOUNDRY_THREAD)"},
		},
		When: hasThreadOrCLI,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.PassUp(ctx, connect.NewRequest(&v1.PassUpQuestionRequest{
				LeadThreadId: a.String("by"), WorkerId: a.String("id"), RequestId: a.String("request"),
			}))
			if err != nil {
				return Result{}, err
			}
			w := res.Msg.GetWorker()
			msg := "passed thread " + threadLabel(w) + "'s question up to the user; keep working. "
			if res.Msg.GetThreadAsk() {
				msg += "It goes on with its assumption; the user's answer reaches it as your message, and you are woken with the answer"
			} else {
				msg += "It waits on the answer, which reaches it as if the user had answered it there; you are woken with the answer"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}
