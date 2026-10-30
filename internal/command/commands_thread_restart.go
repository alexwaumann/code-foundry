package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.restart (docs/notes/plugins-env-restart.md): restart a thread's Claude process
// with the same conversation, so it picks up what changed outside it, such as a
// plugin's session environment (Thread.plugin_env_stale, which the thread info card's
// project row shows; the thread's title menu then offers Restart Claude, running this
// command). Any thread, stale or not. It asks for
// confirmation when the restart cuts something off: a running turn or a pending
// question (interrupted), background agents or shells (stopped), a report Claude is
// about to make.

// RestartBackend is the slice of ThreadService thread.restart needs.
type RestartBackend interface {
	Restart(context.Context, *connect.Request[v1.RestartThreadRequest]) (*connect.Response[v1.RestartThreadResponse], error)
}

// threadRestartConfirm is thread.restart's confirmation for this call, "" when it cuts
// nothing off (or the thread is unknown: Run reports it).
func threadRestartConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id")}))
	if err != nil {
		return ""
	}
	s := res.Msg.GetThread()
	q := "Restart Claude for " + threadNameOrID(s) + "? The conversation continues"
	if midTurn(s) != "" {
		return q + "; the current turn is interrupted."
	}
	why, ends := archiveInterrupts(s)
	if why == "" {
		return ""
	}
	return q + ", but " + why + "; restarting " + ends + "."
}

func threadRestartCmd(b ThreadBackend, idArg ArgSpec) Command {
	idArg.Positional = true
	return Command{
		Name:  "thread.restart",
		Title: "Restart Claude",
		Description: "Restart a thread's Claude process with the same conversation, so it picks up what changed outside it, " +
			"such as a plugin's environment. A running turn is interrupted; background agents and shells stop. " +
			"A thread whose Claude is not running is left as it is: its next message starts Claude afresh.",
		Category: "Thread",
		Args:     []ArgSpec{idArg},
		When:     hasThread,
		Confirm:  "Restart Claude for {id}? The conversation continues; the current turn is interrupted.",
		ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
			return threadRestartConfirm(ctx, b, a) != ""
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return threadRestartConfirm(ctx, b, a)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Restart(ctx, connect.NewRequest(&v1.RestartThreadRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := "restarting Claude for thread " + threadLabel(s) + "; the conversation continues"
			if !res.Msg.GetRestarted() {
				msg = "Claude is not running for thread " + threadLabel(s) + "; its next message starts it with the current environment"
			}
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

// pluginEnvLine is thread.get's line about a changed plugin environment; "" when the
// running process has the current one.
func pluginEnvLine(s *v1.Thread) string {
	if !s.GetPluginEnvStale() {
		return ""
	}
	l := "plugin environment: changed since Claude started"
	if c := s.GetPluginEnvChange(); c != "" {
		l += " (" + c + ")"
	}
	return l + "; thread restart " + s.GetId() + " applies it"
}
