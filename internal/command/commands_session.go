package command

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// SessionBackend is the slice of SessionService the session.* commands need, in
// generated Connect signatures (see TerminalBackend for why). The session step's (2a)
// API handler, any SessionServiceHandler, and a SessionServiceClient satisfy it.
type SessionBackend interface {
	Create(context.Context, *connect.Request[v1.CreateSessionRequest]) (*connect.Response[v1.CreateSessionResponse], error)
	Fork(context.Context, *connect.Request[v1.ForkSessionRequest]) (*connect.Response[v1.ForkSessionResponse], error)
	List(context.Context, *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error)
	Get(context.Context, *connect.Request[v1.GetSessionRequest]) (*connect.Response[v1.GetSessionResponse], error)
	Rename(context.Context, *connect.Request[v1.RenameSessionRequest]) (*connect.Response[v1.RenameSessionResponse], error)
	Close(context.Context, *connect.Request[v1.CloseSessionRequest]) (*connect.Response[v1.CloseSessionResponse], error)
	Reconnect(context.Context, *connect.Request[v1.ReconnectSessionRequest]) (*connect.Response[v1.ReconnectSessionResponse], error)
	Remove(context.Context, *connect.Request[v1.RemoveSessionRequest]) (*connect.Response[v1.RemoveSessionResponse], error)
	RunIn(context.Context, *connect.Request[v1.RunInSessionRequest]) (*connect.Response[v1.RunInSessionResponse], error)
	Pin(context.Context, *connect.Request[v1.PinSessionRequest]) (*connect.Response[v1.PinSessionResponse], error)
}

var (
	_ SessionBackend = codefoundryv1connect.SessionServiceHandler(nil)
	_ SessionBackend = codefoundryv1connect.SessionServiceClient(nil)
)

// Model aliases and effort levels offered for new sessions. From `claude --help`
// (Claude Code 2.1.294): --model takes an alias ("fable", "opus", "sonnet"; "haiku"
// also works) or a full model name; --effort takes low, medium, high, xhigh, max. The
// SessionService API also accepts full model names.
var (
	SessionModels  = []string{"fable", "opus", "sonnet", "haiku"}
	SessionEfforts = []string{"low", "medium", "high", "xhigh", "max"}
)

// SessionPermissions are session.new's permission values, mapped to the claude
// --permission-mode they select by sessionPermissionModes. Full access
// (bypassPermissions) is deliberately not offered.
var SessionPermissions = []string{"supervised", "accept-edits", "auto"}

var sessionPermissionModes = map[string]v1.PermissionMode{
	"supervised":   v1.PermissionMode_PERMISSION_MODE_SUPERVISED,
	"accept-edits": v1.PermissionMode_PERMISSION_MODE_ACCEPT_EDITS,
	"auto":         v1.PermissionMode_PERMISSION_MODE_AUTO,
}

// splitList splits a comma-separated arg, dropping blanks.
func splitList(v string) []string {
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func hasSession(c Context) bool { return c.ActiveSessionID != "" }

func hasRepoOrWorktree(c Context) bool { return c.ActiveRepoID != "" || c.ActiveWorktreePath != "" }

// canStartThread is session.new's availability: a GUI caller needs an active
// repository or worktree. A CLI caller (no active view) names everything with flags,
// and --workspace or --repos alone are enough, which When cannot see, so Run
// validates instead.
func canStartThread(c Context) bool { return hasRepoOrWorktree(c) || c.ActiveView == "" }

// sessionLabel is "name (id)" or just the id.
func sessionLabel(s *v1.Session) string {
	if s.GetName() != "" {
		return s.GetName() + " (" + s.GetId() + ")"
	}
	return s.GetId()
}

// linkedPRs is session.list's PRS cell: "#5,#6", each prefixed with its repository's
// name when the thread linked pull requests in more than one; "-" when none.
func linkedPRs(s *v1.Session) string {
	links := s.GetLinkedPullRequests()
	if len(links) == 0 {
		return "-"
	}
	mixed := slices.ContainsFunc(links, func(l *v1.LinkedPullRequest) bool { return l.GetSlug() != links[0].GetSlug() })
	out := make([]string, len(links))
	for i, l := range links {
		out[i] = fmt.Sprintf("#%d", l.GetNumber())
		if mixed {
			_, name, _ := strings.Cut(l.GetSlug(), "/")
			out[i] = name + out[i]
		}
	}
	return strings.Join(out, ",")
}

func sessionStateName(s v1.SessionState) string {
	return strings.ToLower(strings.TrimPrefix(s.String(), "SESSION_STATE_"))
}

// RegisterSession registers session.new, session.list, session.focus, session.close,
// session.reconnect, session.rename, session.fork, session.remove, session.run-in, and
// session.pin. The user-facing word is "thread" (titles, descriptions, messages);
// command names and identifiers keep "session".
func RegisterSession(r *Registry, b SessionBackend, e Emitter) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextSession, Description: "Thread id"}
	focus := func(id string) int {
		return e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusSession_{FocusSession: &v1.UiIntent_FocusSession{SessionId: id}}})
	}
	return r.RegisterAll(
		Command{
			Name:  "session.new",
			Title: "New Thread",
			Description: "Start Claude Code in a worktree (default: the active worktree, else the active repository's main worktree), or in a new worktree. " +
				"With workspace the thread belongs to that workspace and runs in one of its member worktrees; with new-worktree and repos it gets a new workspace.",
			Category:    "Thread",
			Keybindings: []string{"cmd+n"},
			Args: []ArgSpec{
				{Name: "repo", Type: String, Context: ContextRepo, Description: "Repository id (with workspace or repos: the member the thread runs in, by id or name)"},
				{Name: "worktree", Type: Path, Context: ContextWorktree, Description: "Worktree path (with workspace: a member worktree)"},
				{Name: "workspace", Type: String, Description: "Workspace id or name the thread belongs to; it runs in the member repo or worktree names (default: the first member)"},
				{Name: "repos", Type: String, Description: "With new-worktree: comma-separated repositories (id, name, or path; repo:base gives that one its own base) for a new workspace, a cf/<name> worktree in each; repo picks the member the thread runs in (default: the first)"},
				{Name: "model", Type: Enum, Enum: SessionModels, Description: "Model (default: settings sessions.default_model)"},
				{Name: "effort", Type: Enum, Enum: SessionEfforts, Description: "Effort level (default: settings sessions.default_effort)"},
				{Name: "permission", Type: Enum, Enum: SessionPermissions, Default: "auto",
					Description: "Permissions: supervised (confirm every tool call), accept-edits (file edits allowed), or auto (Claude's auto mode)"},
				{Name: "new-worktree", Type: Bool, Description: "Create a new worktree for the thread (branch cf/<name from the prompt>)"},
				{Name: "base", Type: String, Description: "Ref the new worktree branches from (default: origin/<default branch>); needs new-worktree"},
				{Name: "name", Type: String, Description: "Thread name (default: generated from the first message)"},
				{Name: "prompt", Type: String, Description: "First prompt, passed to Claude as it starts"},
				{Name: "attachments", Type: String, Description: "Comma-separated image paths from StageAttachment, appended to the prompt"},
			},
			When: canStartThread,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				ws, repos := a.String("workspace"), splitList(a.String("repos"))
				if a.String("repo") == "" && a.Path("worktree") == "" && ws == "" && len(repos) == 0 {
					return Result{}, InvalidArg("worktree", "a worktree, repository, or workspace is required")
				}
				req := &v1.CreateSessionRequest{
					RepoId: a.String("repo"), WorktreePath: a.Path("worktree"), Model: a.String("model"),
					Effort: a.String("effort"), Name: a.String("name"), InitialPrompt: a.String("prompt"),
					PermissionMode: sessionPermissionModes[a.String("permission")], Attachments: splitList(a.String("attachments")),
					WorkspaceId: ws,
				}
				switch {
				case len(repos) > 0 && !a.Bool("new-worktree"):
					return Result{}, InvalidArg("repos", "only applies with new-worktree (a new workspace); for an existing one use workspace")
				case ws != "" && a.Bool("new-worktree"):
					return Result{}, InvalidArg("workspace", "a workspace thread runs in an existing member; for a new workspace use new-worktree with repos")
				case len(repos) > 0:
					req.NewWorkspace = &v1.NewWorkspace{Repos: repos, BaseRef: a.String("base")}
				case a.Bool("new-worktree"):
					req.NewWorktree = &v1.NewWorktree{BaseRef: a.String("base")}
				case a.String("base") != "":
					return Result{}, InvalidArg("base", "only applies with new-worktree")
				}
				res, err := b.Create(ctx, connect.NewRequest(req))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSession()
				focus(s.GetId())
				msg := "created thread " + sessionLabel(s) + " in " + s.GetWorktreePath()
				if s.GetWorkspaceId() != "" {
					msg += " (workspace " + s.GetWorkspaceId() + ")"
				}
				if s.GetCreatedWorktree() {
					msg += " (new worktree from " + s.GetBaseRef() + ")"
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
		Command{
			Name:        "session.list",
			Title:       "List Threads",
			Description: "List every thread, connected and disconnected.",
			Category:    "Thread",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
				if err != nil {
					return Result{}, err
				}
				var sb strings.Builder
				tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "ID\tNAME\tSTATE\tSTATUS\tREASON\tWORKSPACE\tPRS\tWORKTREE")
				for _, s := range res.Msg.GetSessions() {
					status := strings.ToLower(strings.TrimPrefix(s.GetStatus().String(), "SESSION_STATUS_"))
					// The reason explains the state when disconnected, else the status.
					reason := s.GetStatusReason()
					if s.GetState() == v1.SessionState_SESSION_STATE_DISCONNECTED {
						reason = s.GetDisconnectReason()
					}
					_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", s.GetId(), s.GetName(), sessionStateName(s.GetState()),
						status, reason, cmp.Or(s.GetWorkspaceId(), "-"), linkedPRs(s), s.GetWorktreePath())
				}
				_ = tw.Flush()
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "session.focus",
			Title:       "Focus Thread",
			Description: "Show a thread in every connected window.",
			Category:    "Thread",
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				n := focus(a.String("id"))
				return Result{Message: fmt.Sprintf("delivered=%d", n), JSON: EmitResult{Delivered: n}}, nil
			},
		},
		Command{
			Name:        "session.close",
			Title:       "Close Thread",
			Description: "End Claude gracefully. The thread stays listed, disconnected, until removed.",
			Category:    "Thread",
			// Not cmd+w: the side panel closes its active tab with it (ReservedChords).
			Keybindings: []string{"cmd+shift+w"},
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := b.Close(ctx, connect.NewRequest(&v1.CloseSessionRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "closed thread " + id}, nil
			},
		},
		Command{
			Name:        "session.reconnect",
			Title:       "Reconnect Thread",
			Description: "Resume a disconnected thread's conversation in a new Claude process.",
			Category:    "Thread",
			Keybindings: []string{"cmd+shift+r"},
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				cur, err := b.Get(ctx, connect.NewRequest(&v1.GetSessionRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				if st := cur.Msg.GetSession().GetState(); st != v1.SessionState_SESSION_STATE_DISCONNECTED {
					return Result{}, connect.NewError(connect.CodeFailedPrecondition,
						fmt.Errorf("thread %s is %s; only a disconnected thread can be reconnected", id, sessionStateName(st)))
				}
				res, err := b.Reconnect(ctx, connect.NewRequest(&v1.ReconnectSessionRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSession()
				msg := "reconnecting thread " + sessionLabel(s)
				if s.GetLastError() != "" {
					msg += ": " + s.GetLastError()
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
		Command{
			Name:        "session.rename",
			Title:       "Rename Thread",
			Description: "Set the thread's name. Turns off automatic naming.",
			Category:    "Thread",
			Keybindings: []string{"cmd+r"},
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Required: true, Description: "New name"}},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Rename(ctx, connect.NewRequest(&v1.RenameSessionRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "renamed thread " + sessionLabel(res.Msg.GetSession()), JSON: res.Msg.GetSession()}, nil
			},
		},
		Command{
			Name:        "session.fork",
			Title:       "Fork Thread",
			Description: "Start a new thread that continues this thread's conversation.",
			Category:    "Thread",
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Description: "Name for the fork"}},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Fork(ctx, connect.NewRequest(&v1.ForkSessionRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSession()
				focus(s.GetId())
				return Result{Message: "forked " + a.String("id") + " into " + sessionLabel(s), JSON: s}, nil
			},
		},
		Command{
			Name:        "session.remove",
			Title:       "Remove Thread",
			Description: "Forget a thread, closing it first if it is connected.",
			Category:    "Thread",
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Confirm:     "Remove thread {id}? It is closed first if connected, and its row is forgotten.",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveSessionRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed thread " + id}, nil
			},
		},
		sessionRunIn(b, idArg),
		sessionPin(b, idArg),
	)
}
