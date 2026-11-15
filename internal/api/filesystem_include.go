package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// suggestTimeout bounds one SuggestIncludeIgnored.
const suggestTimeout = 10 * time.Second

// SuggestIncludeIgnored lists the ignored entries of a project's main worktree for the
// field that adds an include pattern, and counts what the typed text would include.
func (h *Filesystem) SuggestIncludeIgnored(ctx context.Context, req *connect.Request[v1.SuggestIncludeIgnoredRequest]) (*connect.Response[v1.SuggestIncludeIgnoredResponse], error) {
	msg := req.Msg
	if msg.GetLimit() < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit %d is negative", msg.GetLimit()))
	}
	c, err := h.resolve(msg.GetProjectId(), "")
	if err != nil {
		return nil, err
	}
	if !c.git {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("project %s is not a git repository, so it has no ignored files", c.project.Name))
	}
	ctx, cancel := context.WithTimeout(ctx, suggestTimeout)
	defer cancel()
	got, err := fsx.SuggestIgnored(ctx, c.dir, h.includes(c.project), msg.GetText(), int(msg.GetLimit()))
	switch {
	case err == nil:
	case errors.Is(err, context.Canceled):
		return nil, connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return nil, connect.NewError(connect.CodeDeadlineExceeded, err)
	default:
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &v1.SuggestIncludeIgnoredResponse{
		Truncated: got.Truncated, TextFiles: int32(got.TextFiles), TextFilesCapped: got.TextFilesCapped, TextError: got.TextError,
		Suggestions: make([]*v1.IgnoredSuggestion, len(got.Entries)),
	}
	for i, e := range got.Entries {
		out.Suggestions[i] = &v1.IgnoredSuggestion{
			Path: e.Path, IsDir: e.Dir, FileCount: int32(e.Files), FileCountCapped: e.FilesCapped,
			Included: e.Included, MatchesText: e.MatchesText, PathPositions: int32s(e.Positions),
		}
	}
	return connect.NewResponse(out), nil
}
