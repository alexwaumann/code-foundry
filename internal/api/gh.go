package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/store/gh"
)

// watchBuffer is the per-stream bus buffer. Events are notifications to re-read, so a
// dropped one only delays a refresh until the next poll.
const watchBuffer = 64

// Gh implements codefoundryv1connect.GhServiceHandler over a gh.Service.
type Gh struct {
	store gh.Service
	bus   *bus.Bus
	done  <-chan struct{}
}

var _ codefoundryv1connect.GhServiceHandler = (*Gh)(nil)

// NewGh returns a GhService handler. Watch streams end when their request is cancelled
// or done is closed (daemon shutdown); done may be nil.
func NewGh(store gh.Service, b *bus.Bus, done <-chan struct{}) *Gh {
	return &Gh{store: store, bus: b, done: done}
}

// Route mounts the service.
func (h *Gh) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewGhServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// GetViewer returns the cached viewer and auth state.
func (h *Gh) GetViewer(context.Context, *connect.Request[v1.GetViewerRequest]) (*connect.Response[v1.GetViewerResponse], error) {
	vs := h.store.Snapshot().Viewer
	res := &v1.GetViewerResponse{
		Authenticated: vs.Authenticated,
		FetchedAt:     timestamp(vs.FetchedAt),
		LastError:     vs.LastError,
	}
	if v := vs.Viewer; v != nil {
		res.Viewer = &v1.GhViewer{Login: v.Login, Name: v.Name, AvatarUrl: v.AvatarURL, Url: v.URL}
	}
	return connect.NewResponse(res), nil
}

// ListPullRequests returns a repository's cached open pull requests.
func (h *Gh) ListPullRequests(_ context.Context, req *connect.Request[v1.ListPullRequestsRequest]) (*connect.Response[v1.ListPullRequestsResponse], error) {
	slug, err := gh.NormalizeSlug(req.Msg.GetRepoSlug())
	if err != nil {
		return nil, ghError(err)
	}
	r := h.store.Snapshot().Repos[slug]
	res := &v1.ListPullRequestsResponse{
		PullRequests: make([]*v1.PullRequest, 0, len(r.PullRequests)),
		Tracked:      r.Tracked,
		FetchedAt:    timestamp(r.FetchedAt),
		LastError:    r.LastError,
		TotalCount:   int32(r.TotalCount),
	}
	for i := range r.PullRequests {
		res.PullRequests = append(res.PullRequests, pullRequestToProto(slug, &r.PullRequests[i]))
	}
	return connect.NewResponse(res), nil
}

// GetPullRequest returns one pull request with its checks.
func (h *Gh) GetPullRequest(ctx context.Context, req *connect.Request[v1.GetPullRequestRequest]) (*connect.Response[v1.GetPullRequestResponse], error) {
	d, err := h.store.PullRequest(ctx, req.Msg.GetRepoSlug(), int(req.Msg.GetNumber()))
	if err != nil {
		return nil, ghError(err)
	}
	slug, _ := gh.NormalizeSlug(req.Msg.GetRepoSlug())
	return connect.NewResponse(&v1.GetPullRequestResponse{
		PullRequest: pullRequestToProto(slug, &d.PullRequest),
		Checks:      checkRunsToProto(d.Checks),
		FetchedAt:   timestamp(d.FetchedAt),
		LastError:   d.LastError,
	}), nil
}

// ListChecks returns the checks on a ref.
func (h *Gh) ListChecks(ctx context.Context, req *connect.Request[v1.ListChecksRequest]) (*connect.Response[v1.ListChecksResponse], error) {
	c, err := h.store.Checks(ctx, req.Msg.GetRepoSlug(), req.Msg.GetRef())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.ListChecksResponse{
		Sha:       c.SHA,
		Rollup:    rollupToProto(c.Rollup),
		Checks:    checkRunsToProto(c.Runs),
		FetchedAt: timestamp(c.FetchedAt),
		LastError: c.LastError,
	}), nil
}

// Refresh forwards to the store.
func (h *Gh) Refresh(ctx context.Context, req *connect.Request[v1.RefreshGhRequest]) (*connect.Response[v1.RefreshGhResponse], error) {
	if err := h.store.Refresh(ctx, req.Msg.GetRepoSlug()); err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.RefreshGhResponse{}), nil
}

// Track forwards to the store.
func (h *Gh) Track(_ context.Context, req *connect.Request[v1.TrackGhRepoRequest]) (*connect.Response[v1.TrackGhRepoResponse], error) {
	if err := h.store.Track(req.Msg.GetRepoSlug()); err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.TrackGhRepoResponse{}), nil
}

// Untrack forwards to the store.
func (h *Gh) Untrack(_ context.Context, req *connect.Request[v1.UntrackGhRepoRequest]) (*connect.Response[v1.UntrackGhRepoResponse], error) {
	if err := h.store.Untrack(req.Msg.GetRepoSlug()); err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.UntrackGhRepoResponse{}), nil
}

// Watch streams change notifications until the client cancels or the daemon stops.
func (h *Gh) Watch(ctx context.Context, _ *connect.Request[v1.WatchGhRequest], stream *connect.ServerStream[v1.GhEvent]) error {
	prs := bus.Subscribe[gh.PullRequestsUpdated](h.bus, watchBuffer)
	defer prs.Close()
	viewer := bus.Subscribe[gh.ViewerUpdated](h.bus, watchBuffer)
	defer viewer.Close()
	// Flush response headers now: clients (connect-go and connect-web) block until they
	// arrive, and the first event may be a poll interval away. Subscribing first means
	// nothing published after the client sees the stream open is missed.
	if err := stream.Send(nil); err != nil {
		return err
	}
	for {
		var ev *v1.GhEvent
		select {
		case <-ctx.Done():
			return nil
		case <-h.done:
			return nil
		case e := <-prs.C():
			ev = &v1.GhEvent{Event: &v1.GhEvent_PullRequestsUpdated_{PullRequestsUpdated: &v1.GhEvent_PullRequestsUpdated{
				RepoSlug: e.Slug, FetchedAt: timestamp(e.FetchedAt),
			}}}
		case e := <-viewer.C():
			ev = &v1.GhEvent{Event: &v1.GhEvent_ViewerUpdated_{ViewerUpdated: &v1.GhEvent_ViewerUpdated{
				FetchedAt: timestamp(e.FetchedAt),
			}}}
		}
		if err := stream.Send(ev); err != nil {
			return err
		}
	}
}

// ghErrorCodes maps store errors to Connect codes, first match wins. Not-authenticated
// is FailedPrecondition, not Unauthenticated: the caller is authenticated to the
// daemon; it is gh that needs `gh auth login`.
var ghErrorCodes = []struct {
	err  error
	code connect.Code
}{
	{gh.ErrInvalidSlug, connect.CodeInvalidArgument},
	{gh.ErrInvalidArgument, connect.CodeInvalidArgument},
	{gh.ErrNotFound, connect.CodeNotFound},
	{gh.ErrNotAuthenticated, connect.CodeFailedPrecondition},
	{gh.ErrRateLimited, connect.CodeResourceExhausted},
	{gh.ErrNetwork, connect.CodeUnavailable},
	{gh.ErrServerTimeout, connect.CodeUnavailable},
	{context.Canceled, connect.CodeCanceled},
	{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
}

func ghError(err error) error {
	for _, m := range ghErrorCodes {
		if errors.Is(err, m.err) {
			return connect.NewError(m.code, err)
		}
	}
	return connect.NewError(connect.CodeUnknown, err)
}

func timestamp(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

// enumOf maps GitHub's enum string to the proto enum whose value names are
// prefix+GitHub's name; unknown or empty strings map to UNSPECIFIED (0).
func enumOf[E ~int32](values map[string]int32, prefix, s string) E {
	if s == "" {
		return 0
	}
	return E(values[prefix+s])
}

func pullRequestToProto(slug string, p *gh.PullRequest) *v1.PullRequest {
	return &v1.PullRequest{
		RepoSlug:          slug,
		Number:            int32(p.Number),
		Title:             p.Title,
		Author:            p.Author,
		HeadRef:           p.HeadRef,
		HeadSha:           p.HeadSHA,
		BaseRef:           p.BaseRef,
		Draft:             p.Draft,
		ReviewDecision:    enumOf[v1.ReviewDecision](v1.ReviewDecision_value, "REVIEW_DECISION_", string(p.ReviewDecision)),
		Mergeable:         enumOf[v1.Mergeable](v1.Mergeable_value, "MERGEABLE_", string(p.Mergeable)),
		MergeStateStatus:  enumOf[v1.MergeStateStatus](v1.MergeStateStatus_value, "MERGE_STATE_STATUS_", string(p.MergeStateStatus)),
		IsCrossRepository: p.IsCrossRepository,
		HeadRepoSlug:      p.HeadRepoSlug,
		Url:               p.URL,
		UpdatedAt:         timestamp(p.UpdatedAt),
		Checks:            rollupToProto(p.Checks),
	}
}

func rollupToProto(r gh.CheckRollup) *v1.CheckRollup {
	return &v1.CheckRollup{
		State:   enumOf[v1.CheckRollupState](v1.CheckRollupState_value, "CHECK_ROLLUP_STATE_", string(r.State)),
		Total:   int32(r.Total),
		Passed:  int32(r.Passed),
		Failed:  int32(r.Failed),
		Pending: int32(r.Pending),
		Skipped: int32(r.Skipped),
	}
}

func checkRunsToProto(runs []gh.CheckRun) []*v1.CheckRun {
	out := make([]*v1.CheckRun, 0, len(runs))
	for _, r := range runs {
		out = append(out, &v1.CheckRun{
			Name:        r.Name,
			Workflow:    r.Workflow,
			Status:      enumOf[v1.CheckStatus](v1.CheckStatus_value, "CHECK_STATUS_", string(r.Status)),
			Conclusion:  enumOf[v1.CheckConclusion](v1.CheckConclusion_value, "CHECK_CONCLUSION_", string(r.Conclusion)),
			Url:         r.URL,
			Description: r.Description,
			StartedAt:   timestamp(r.StartedAt),
			CompletedAt: timestamp(r.CompletedAt),
		})
	}
	return out
}
