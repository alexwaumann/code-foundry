package command

import (
	"context"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// A thread's own background shells (Thread.background_shells; docs/notes/thread-servers.md):
// thread.get lists them with the ports they listen on, thread.shell.stop stops one (the
// thread info card's stop square on a server row).

// ShellBackend is the slice of ThreadService thread.shell.stop needs.
type ShellBackend interface {
	StopShell(context.Context, *connect.Request[v1.StopThreadShellRequest]) (*connect.Response[v1.StopThreadShellResponse], error)
}

func threadShellStopCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.shell.stop",
		NoPalette: true,
		Title:     "Stop Background Shell",
		Description: "Stop one of a thread's own background shells (a Bash call run in the background, a Monitor): its process " +
			"group gets SIGTERM, then SIGKILL 3 seconds later. A note in the conversation records it; Claude sees the shell end.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "task", Type: String, Required: true, Positional: true, Description: "The shell's task id (thread get lists them)"},
			idArg,
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.StopShell(ctx, connect.NewRequest(&v1.StopThreadShellRequest{ThreadId: a.String("id"), TaskId: a.String("task")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: "stopping background shell " + a.String("task") + " of thread " + threadLabel(res.Msg.GetThread()), JSON: res.Msg}, nil
		},
	}
}

// shellLines are thread.get's lines for the running background shells: "background
// shell b1x2: python3 -m http.server 9399 (localhost:9399)".
func shellLines(s *v1.Thread) []string {
	var out []string
	for _, sh := range s.GetBackgroundShells() {
		what := sh.GetCommand()
		if what == "" {
			what = sh.GetDescription()
		}
		if i := strings.IndexByte(what, '\n'); i >= 0 {
			what = what[:i] + " …"
		}
		l := "background shell " + sh.GetTaskId() + ": " + what
		if ps := sh.GetPorts(); len(ps) > 0 {
			addrs := make([]string, len(ps))
			for i, p := range ps {
				addrs[i] = "localhost:" + strconv.FormatUint(uint64(p), 10)
			}
			l += " (" + strings.Join(addrs, ", ") + ")"
		}
		out = append(out, l)
	}
	return out
}
