package api

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/ripgrep"
	"github.com/alexwaumann/code-foundry/internal/textsearch"
)

// SearchText searches the contents of the sources' files (package textsearch) and streams
// the files with matches as they come, then the summary.
func (h *Filesystem) SearchText(ctx context.Context, req *connect.Request[v1.SearchTextRequest], stream *connect.ServerStream[v1.SearchTextResponse]) error {
	msg := req.Msg
	named := msg.GetSources()
	switch {
	case len(named) == 0:
		return connect.NewError(connect.CodeInvalidArgument, errors.New("sources is required"))
	case len(named) > fsx.MaxSearchSources:
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%d sources, at most %d", len(named), fsx.MaxSearchSources))
	}
	srcs, meta, err := h.searchSources(named)
	if err != nil {
		return err
	}
	q := textsearch.Query{Text: msg.GetQuery(), MatchCase: msg.GetMatchCase(), WholeWord: msg.GetWholeWord(), Regex: msg.GetRegex()}
	sum, err := h.text.Search(ctx, srcs, q, func(files []textsearch.File) error {
		out := &v1.SearchTextResponse{Files: make([]*v1.TextFileMatch, len(files))}
		for i, f := range files {
			out.Files[i] = textFileMatch(f, meta[f.Source])
		}
		return stream.Send(out)
	})
	if err != nil {
		return textSearchError(err)
	}
	return stream.Send(&v1.SearchTextResponse{Summary: &v1.SearchTextSummary{
		Lines: int32(sum.Lines), Files: int32(sum.Files), Truncated: sum.Truncated(),
		FileCapped: sum.FileCapped, TotalCapped: sum.TotalCapped, TimedOut: sum.TimedOut,
		CaseSensitive: sum.CaseSensitive, ElapsedMs: sum.Elapsed.Milliseconds(), IncludedCapped: sum.IncludeCapped,
	}})
}

func textFileMatch(f textsearch.File, src checkoutSource) *v1.TextFileMatch {
	out := &v1.TextFileMatch{
		ProjectId: src.projectID, Checkout: src.checkout, Path: f.Path, Ignored: f.Ignored,
		Lines: make([]*v1.TextLineMatch, len(f.Lines)), LineCount: int32(f.LineCount), LineCountCapped: f.LineCountCapped,
	}
	for i, l := range f.Lines {
		ranges := make([]*v1.TextRange, len(l.Ranges))
		for j, r := range l.Ranges {
			ranges[j] = &v1.TextRange{Start: int32(r.Start), End: int32(r.End)}
		}
		out.Lines[i] = &v1.TextLineMatch{Line: int32(l.Number), Text: l.Text, Ranges: ranges, CutStart: l.CutStart, CutEnd: l.CutEnd}
	}
	return out
}

// textSearchError maps a search's error to its code. A connect error (the stream's send
// failing) passes through.
func textSearchError(err error) error {
	var ce *connect.Error
	switch {
	case errors.As(err, &ce):
		return err
	case errors.Is(err, textsearch.ErrInvalidQuery):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, ripgrep.ErrMissing), errors.Is(err, ripgrep.ErrBroken):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}
