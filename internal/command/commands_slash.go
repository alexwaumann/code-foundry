package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// A running thread's slash commands (docs/notes/slash-commands-1-daemon.md):
// thread.commands prints what the composer's "/" offers.

// SlashBackend is the slice of ThreadService thread.commands needs, in generated Connect
// signatures. The API handler, any ThreadServiceHandler and a ThreadServiceClient
// satisfy it.
type SlashBackend interface {
	SlashCommands(context.Context, *connect.Request[v1.SlashCommandsRequest]) (*connect.Response[v1.SlashCommandsResponse], error)
}

var (
	_ SlashBackend = codefoundryv1connect.ThreadServiceHandler(nil)
	_ SlashBackend = codefoundryv1connect.ThreadServiceClient(nil)
)

// SlashCommandJSON is one entry of thread.commands' JSON result (a list).
type SlashCommandJSON struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	ArgumentHint string   `json:"argumentHint"`
	Aliases      []string `json:"aliases,omitempty"`
	Builtin      bool     `json:"builtin"`
}

// RegisterSlash registers thread.commands.
func RegisterSlash(r *Registry, b SlashBackend) error {
	return r.Register(Command{
		Name:  "thread.commands",
		Title: "Show Thread Slash Commands",
		Description: "Print the slash commands a running thread offers: Claude's own list (skills, user and project commands, " +
			"plugin skills and built-ins), minus the ones the app replaces or that mean nothing outside Claude's terminal.",
		Category: "Thread",
		Args:     []ArgSpec{{Name: "id", Type: String, Required: true, Context: ContextSession, Description: "Thread id"}},
		When:     hasSession,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.SlashCommands(ctx, connect.NewRequest(&v1.SlashCommandsRequest{SessionId: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			cs := res.Msg.GetCommands()
			list := make([]SlashCommandJSON, len(cs))
			for i, c := range cs {
				list[i] = SlashCommandJSON{Name: c.GetName(), Description: c.GetDescription(), ArgumentHint: c.GetArgumentHint(), Aliases: c.GetAliases(), Builtin: c.GetBuiltin()}
			}
			return Result{Message: FormatSlashCommands(cs), JSON: list}, nil
		},
	})
}

// FormatSlashCommands is thread.commands' table: NAME, ARGS, DESCRIPTION (its first
// line, cut), in the thread's order.
func FormatSlashCommands(cs []*v1.SlashCommand) string {
	if len(cs) == 0 {
		return "no slash commands: the thread is not running (reconnect it first)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d slash commands\n", len(cs))
	tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tARGS\tDESCRIPTION")
	for _, c := range cs {
		fmt.Fprintf(tw, "/%s\t%s\t%s\n", c.GetName(), dash(c.GetArgumentHint()), firstLine(c.GetDescription()))
	}
	_ = tw.Flush()
	return strings.TrimRight(b.String(), "\n")
}
