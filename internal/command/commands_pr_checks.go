package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// PullRequestChecksBackend reads a pull request with its head commit's checks
// (GhService.GetPullRequest, served from the gh store's cache).
type PullRequestChecksBackend interface {
	GetPullRequest(context.Context, *connect.Request[v1.GetPullRequestRequest]) (*connect.Response[v1.GetPullRequestResponse], error)
}

var (
	_ PullRequestChecksBackend = codefoundryv1connect.GhServiceHandler(nil)
	_ PullRequestChecksBackend = codefoundryv1connect.GhServiceClient(nil)
)

// PullRequestChecksDeps are pr.checks' dependencies.
type PullRequestChecksDeps struct {
	// Gh reads the checks. Nil registers against UnimplementedGhServiceHandler.
	Gh PullRequestChecksBackend
	// ThreadPullRequest is a thread's pull request: its branch's (an open one first),
	// else the newest one Claude linked. Nil: only explicit pull requests.
	ThreadPullRequest func(ctx context.Context, threadID string) (slug string, number int, ok bool)
}

// CheckRunJSON is one check in pr.checks --json.
type CheckRunJSON struct {
	Name     string `json:"name"`
	Workflow string `json:"workflow,omitempty"`
	// Status is queued, in_progress, completed, waiting, pending or requested.
	Status string `json:"status"`
	// Conclusion is set once completed: success, failure, neutral, cancelled, skipped,
	// timed_out, action_required, stale, startup_failure.
	Conclusion string `json:"conclusion,omitempty"`
	// App is the check run's GitHub App slug; Provider is App, else "github-actions"
	// for an Actions URL, else "status" (pluginsdk.CheckProvider).
	App         string    `json:"app,omitempty"`
	Provider    string    `json:"provider"`
	URL         string    `json:"url,omitempty"`
	StartedAt   time.Time `json:"startedAt,omitzero"`
	CompletedAt time.Time `json:"completedAt,omitzero"`
}

// PullRequestChecksJSON is pr.checks --json.
type PullRequestChecksJSON struct {
	Repo      string         `json:"repo"`
	Number    int            `json:"number"`
	URL       string         `json:"url,omitempty"`
	HeadSHA   string         `json:"headSha,omitempty"`
	FetchedAt time.Time      `json:"fetchedAt,omitzero"`
	LastError string         `json:"lastError,omitempty"`
	Checks    []CheckRunJSON `json:"checks"`
}

func lowerEnum(s, prefix string) string {
	s = strings.TrimPrefix(s, prefix)
	if s == "UNSPECIFIED" {
		return ""
	}
	return strings.ToLower(s)
}

// RegisterPullRequestChecks registers pr.checks.
func RegisterPullRequestChecks(r *Registry, d PullRequestChecksDeps) error {
	if d.Gh == nil {
		d.Gh = codefoundryv1connect.UnimplementedGhServiceHandler{}
	}
	return r.Register(Command{
		Name:  "pr.checks",
		Title: "List Pull Request Checks",
		Description: "List the checks on a pull request's head commit: name, workflow, status, conclusion, the GitHub App " +
			"that ran it (provider: github-actions, another app, or status for commit statuses), its details URL, and " +
			"when it started and completed. Name the pull request (repo-slug and number) or a thread (--thread, " +
			"--context-thread): its branch's pull request, else the newest one Claude linked. Cached for about 30 s, " +
			"and fetched again once the GitHub poll sees the pull request move.",
		Category:     "Pull Request",
		NoKeybinding: true,
		Args: []ArgSpec{
			{Name: "repo-slug", Type: String, Positional: true, Description: `GitHub repository, "owner/name"`},
			{Name: "number", Type: Int, Positional: true, Description: "Pull request number"},
			{Name: "thread", Type: String, Context: ContextThread, ID: ThreadID, Description: "A thread whose pull request to read" + IDHelp},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			slug, number := strings.TrimSpace(a.String("repo-slug")), a.Int("number")
			switch {
			case slug != "" && number > 0:
			case slug != "" || a.Has("number"):
				if err := checkPullRequestArgs(a); err != nil {
					return Result{}, err
				}
			case a.String("thread") != "" && d.ThreadPullRequest != nil:
				var ok bool
				if slug, number, ok = d.ThreadPullRequest(ctx, a.String("thread")); !ok {
					return Result{}, fmt.Errorf("%w: thread %s has no pull request", ErrUnavailable, a.String("thread"))
				}
			default:
				return Result{}, InvalidArg("repo-slug", "name a pull request (repo-slug and number) or a thread (--thread)")
			}
			res, err := d.Gh.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: slug, Number: int32(number)}))
			if err != nil {
				return Result{}, err
			}
			out := PullRequestChecksJSON{Repo: slug, Number: number, URL: res.Msg.GetPullRequest().GetUrl(),
				HeadSHA: res.Msg.GetPullRequest().GetHeadSha(), LastError: res.Msg.GetLastError(), Checks: []CheckRunJSON{}}
			if t := res.Msg.GetFetchedAt(); t != nil {
				out.FetchedAt = t.AsTime()
			}
			for _, c := range res.Msg.GetChecks() {
				cj := CheckRunJSON{Name: c.GetName(), Workflow: c.GetWorkflow(),
					Status:     lowerEnum(c.GetStatus().String(), "CHECK_STATUS_"),
					Conclusion: lowerEnum(c.GetConclusion().String(), "CHECK_CONCLUSION_"),
					App:        c.GetApp(), Provider: pluginsdk.CheckProvider(c.GetApp(), c.GetUrl()), URL: c.GetUrl()}
				if t := c.GetStartedAt(); t != nil {
					cj.StartedAt = t.AsTime()
				}
				if t := c.GetCompletedAt(); t != nil {
					cj.CompletedAt = t.AsTime()
				}
				out.Checks = append(out.Checks, cj)
			}
			return Result{Message: formatChecks(out), JSON: out}, nil
		},
	})
}

func formatChecks(p PullRequestChecksJSON) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s#%d", p.Repo, p.Number)
	if p.URL != "" {
		sb.WriteString(" " + p.URL)
	}
	if p.LastError != "" {
		sb.WriteString(" (cached; refresh failed: " + p.LastError + ")")
	}
	sb.WriteString("\n")
	if len(p.Checks) == 0 {
		sb.WriteString("no checks")
		return sb.String()
	}
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "NAME\tSTATUS\tPROVIDER\tSTARTED\tCOMPLETED\tURL")
	stamp := func(t time.Time) string {
		if t.IsZero() {
			return "-"
		}
		return t.Local().Format("01-02 15:04")
	}
	for _, c := range p.Checks {
		name := c.Name
		if c.Workflow != "" {
			name = c.Workflow + " / " + c.Name
		}
		status := c.Status
		if c.Conclusion != "" {
			status = c.Conclusion
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", name, status, c.Provider, stamp(c.StartedAt), stamp(c.CompletedAt), c.URL)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}
