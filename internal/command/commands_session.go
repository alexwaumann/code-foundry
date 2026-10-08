package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
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

func hasSession(c Context) bool { return c.ActiveSessionID != "" }

func hasRepoOrWorktree(c Context) bool { return c.ActiveRepoID != "" || c.ActiveWorktreePath != "" }

// sessionLabel is "name (id)" or just the id.
func sessionLabel(s *v1.Session) string {
	if s.GetName() != "" {
		return s.GetName() + " (" + s.GetId() + ")"
	}
	return s.GetId()
}

func sessionStateName(s v1.SessionState) string {
	return strings.ToLower(strings.TrimPrefix(s.String(), "SESSION_STATE_"))
}

// RegisterSession registers session.new, session.list, session.focus, session.close,
// session.reconnect, session.rename, session.fork, and session.remove.
func RegisterSession(r *Registry, b SessionBackend, e Emitter) error {
	idArg := ArgSpec{Name: "id", Type: String, Required: true, Context: ContextSession, Description: "Session id"}
	focus := func(id string) int {
		return e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusSession_{FocusSession: &v1.UiIntent_FocusSession{SessionId: id}}})
	}
	return r.RegisterAll(
		Command{
			Name:        "session.new",
			Title:       "New Session",
			Description: "Start Claude Code in a worktree (default: the active worktree, else the active repository's main worktree).",
			Category:    "Session",
			Keybindings: []string{"cmd+n"},
			Args: []ArgSpec{
				{Name: "repo", Type: String, Context: ContextRepo, Description: "Repository id"},
				{Name: "worktree", Type: Path, Context: ContextWorktree, Description: "Worktree path"},
				{Name: "model", Type: Enum, Enum: SessionModels, Description: "Model (default: Claude's default)"},
				{Name: "effort", Type: Enum, Enum: SessionEfforts, Description: "Effort level (default: Claude's default)"},
				{Name: "name", Type: String, Description: "Session name (default: generated from the first message)"},
				{Name: "prompt", Type: String, Description: "First prompt to send once Claude is ready"},
			},
			When: hasRepoOrWorktree,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if a.String("repo") == "" && a.Path("worktree") == "" {
					return Result{}, InvalidArg("worktree", "a worktree or repository is required")
				}
				res, err := b.Create(ctx, connect.NewRequest(&v1.CreateSessionRequest{
					RepoId: a.String("repo"), WorktreePath: a.Path("worktree"), Model: a.String("model"),
					Effort: a.String("effort"), Name: a.String("name"), InitialPrompt: a.String("prompt"),
				}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSession()
				focus(s.GetId())
				return Result{Message: "created session " + sessionLabel(s) + " in " + s.GetWorktreePath(), JSON: s}, nil
			},
		},
		Command{
			Name:        "session.list",
			Title:       "List Sessions",
			Description: "List every session, connected and disconnected.",
			Category:    "Session",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
				if err != nil {
					return Result{}, err
				}
				var sb strings.Builder
				tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "ID\tNAME\tSTATE\tSTATUS\tREASON\tWORKTREE")
				for _, s := range res.Msg.GetSessions() {
					status := strings.ToLower(strings.TrimPrefix(s.GetStatus().String(), "SESSION_STATUS_"))
					// The reason explains the state when disconnected, else the status.
					reason := s.GetStatusReason()
					if s.GetState() == v1.SessionState_SESSION_STATE_DISCONNECTED {
						reason = s.GetDisconnectReason()
					}
					_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", s.GetId(), s.GetName(), sessionStateName(s.GetState()),
						status, reason, s.GetWorktreePath())
				}
				_ = tw.Flush()
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "session.focus",
			Title:       "Focus Session",
			Description: "Show a session in every connected window.",
			Category:    "Session",
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				n := focus(a.String("id"))
				return Result{Message: fmt.Sprintf("delivered=%d", n), JSON: EmitResult{Delivered: n}}, nil
			},
		},
		Command{
			Name:        "session.close",
			Title:       "Close Session",
			Description: "End Claude gracefully. The session stays listed, disconnected, until removed.",
			Category:    "Session",
			// Not cmd+w: the Wails app menu closes the window with it.
			Keybindings: []string{"cmd+shift+w"},
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := b.Close(ctx, connect.NewRequest(&v1.CloseSessionRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "closed session " + id}, nil
			},
		},
		Command{
			Name:        "session.reconnect",
			Title:       "Reconnect Session",
			Description: "Resume a disconnected session's conversation in a new Claude process.",
			Category:    "Session",
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
						fmt.Errorf("session %s is %s; only a disconnected session can be reconnected", id, sessionStateName(st)))
				}
				res, err := b.Reconnect(ctx, connect.NewRequest(&v1.ReconnectSessionRequest{Id: id}))
				if err != nil {
					return Result{}, err
				}
				s := res.Msg.GetSession()
				msg := "reconnecting session " + sessionLabel(s)
				if s.GetLastError() != "" {
					msg += ": " + s.GetLastError()
				}
				return Result{Message: msg, JSON: s}, nil
			},
		},
		Command{
			Name:        "session.rename",
			Title:       "Rename Session",
			Description: "Set the session's name. Turns off automatic naming.",
			Category:    "Session",
			Keybindings: []string{"cmd+r"},
			Args:        []ArgSpec{idArg, {Name: "name", Type: String, Required: true, Description: "New name"}},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Rename(ctx, connect.NewRequest(&v1.RenameSessionRequest{Id: a.String("id"), Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "renamed session " + sessionLabel(res.Msg.GetSession()), JSON: res.Msg.GetSession()}, nil
			},
		},
		Command{
			Name:        "session.fork",
			Title:       "Fork Session",
			Description: "Start a new session that continues this session's conversation.",
			Category:    "Session",
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
			Title:       "Remove Session",
			Description: "Forget a session, closing it first if it is connected.",
			Category:    "Session",
			Args:        []ArgSpec{idArg},
			When:        hasSession,
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				id := a.String("id")
				if _, err := b.Remove(ctx, connect.NewRequest(&v1.RemoveSessionRequest{Id: id})); err != nil {
					return Result{}, err
				}
				return Result{Message: "removed session " + id}, nil
			},
		},
	)
}
