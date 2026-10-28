package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PromptsBackend backs thread.prompts.
type PromptsBackend interface {
	ListPrompts(context.Context, *connect.Request[v1.ListPromptsRequest]) (*connect.Response[v1.ListPromptsResponse], error)
}

// PromptScopes are thread.prompts' scope values.
var PromptScopes = []string{"thread", "project", "all"}

var promptScopes = map[string]v1.PromptScope{
	"thread":  v1.PromptScope_PROMPT_SCOPE_THREAD,
	"project": v1.PromptScope_PROMPT_SCOPE_PROJECT,
	"all":     v1.PromptScope_PROMPT_SCOPE_ALL,
}

// promptTextWidth is how many characters of a prompt a line shows.
const promptTextWidth = 100

// threadPrompts is thread.prompts: the prompts the user sent
// (docs/notes/prompt-history-1-daemon.md).
func threadPrompts(b PromptsBackend) Command {
	return Command{
		Name:      "thread.prompts",
		NoPalette: true,
		ReadOnly:  true,
		Title:     "List Sent Prompts",
		Description: "List the prompts you sent, newest first: one line each, `<age>  <thread id>  <thread name>  <prompt>`. " +
			"Only your own: wakes, messages threads sent, and attachment-only messages are left out, and so are hidden child " +
			"threads outside thread scope; archived threads count. A run of the same prompt in a thread shows once.",
		Category:     "Thread",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "scope", Type: Enum, Enum: PromptScopes, Description: "thread (its prompts), project (the threads sharing a project " +
				"with it, or with project), or all (default: project with project, else thread when there is one, else all)"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID, Description: "Thread id" + IDHelp +
				" (default: yours); with project scope the anchor whose projects count"},
			{Name: "project", Type: String, Description: "Comma-separated projects (id, name, or a path inside one) for project scope " +
				"instead of a thread's"},
			{Name: "query", Type: String, Description: "Only prompts containing this text (case-insensitive)"},
			{Name: "limit", Type: Int, Default: "50", Description: "At most this many prompts (at most 500)"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.Int("limit") < 1 || a.Int("limit") > 500 {
				return Result{}, InvalidArg("limit", "limit must be 1 to 500, not %d", a.Int("limit"))
			}
			id, projects := strings.TrimSpace(a.String("thread")), splitList(a.String("project"))
			scope := a.String("scope")
			switch {
			case scope == "" && len(projects) > 0:
				scope = "project"
			case scope == "" && id != "":
				scope = "thread"
			case scope == "":
				scope = "all"
			case len(projects) > 0 && scope != "project":
				return Result{}, InvalidArg("project", "project is for project scope, not %s", scope)
			}
			req := &v1.ListPromptsRequest{Scope: promptScopes[scope], Query: a.String("query"), Limit: int32(a.Int("limit"))}
			switch {
			case scope == "thread" && id == "":
				return Result{}, InvalidArg("thread", "thread scope needs a thread: --thread, or run it inside one")
			case scope == "project" && len(projects) > 0:
				req.ProjectIds = projects
			case scope != "all":
				req.ThreadId = id
			}
			res, err := b.ListPrompts(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: FormatPrompts(res.Msg.GetPrompts(), time.Now()), JSON: res.Msg}, nil
		},
	}
}

// FormatPrompts renders thread.prompts: one aligned line per prompt, its text on one
// line and cut at promptTextWidth characters.
func FormatPrompts(prompts []*v1.SentPrompt, now time.Time) string {
	if len(prompts) == 0 {
		return "no prompts"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	for _, p := range prompts {
		name := p.GetThreadName()
		if name == "" {
			name = "(unnamed)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", age(p.GetSentAt().AsTime(), now), p.GetThreadId(), name,
			truncateRunes(oneLineText(p.GetText()), promptTextWidth))
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
