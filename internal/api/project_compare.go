package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// diffSourceKinds maps the sources a request can name; UNSPECIFIED is each side's default.
var diffSourceKinds = map[v1.DiffSourceKind]project.DiffSourceKind{
	v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE:   project.SourceMergeBase,
	v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE: project.SourceWorkingTree,
	v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED:       project.SourceStaged,
	v1.DiffSourceKind_DIFF_SOURCE_KIND_REF:          project.SourceRef,
}

// diffSourceKindsOut is diffSourceKinds the other way.
var diffSourceKindsOut = map[project.DiffSourceKind]v1.DiffSourceKind{
	project.SourceMergeBase:   v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE,
	project.SourceWorkingTree: v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE,
	project.SourceStaged:      v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED,
	project.SourceRef:         v1.DiffSourceKind_DIFF_SOURCE_KIND_REF,
}

// diffSource maps one side of a request, def for an unset one.
func diffSource(s *v1.DiffSource, def project.DiffSourceKind) (project.DiffSource, error) {
	if s.GetKind() == v1.DiffSourceKind_DIFF_SOURCE_KIND_UNSPECIFIED {
		return project.DiffSource{Kind: def, Ref: s.GetRef()}, nil
	}
	k, ok := diffSourceKinds[s.GetKind()]
	if !ok {
		return project.DiffSource{}, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown source %v", s.GetKind()))
	}
	return project.DiffSource{Kind: k, Ref: s.GetRef()}, nil
}

// compareSides maps a request's two sides.
func compareSides(base, head *v1.DiffSource) (b, h project.DiffSource, err error) {
	if b, err = diffSource(base, project.SourceMergeBase); err != nil {
		return b, h, err
	}
	h, err = diffSource(head, project.SourceWorkingTree)
	return b, h, err
}

func resolvedSourceToProto(s project.ResolvedSource) *v1.ResolvedDiffSource {
	return &v1.ResolvedDiffSource{Kind: diffSourceKindsOut[s.Kind], Label: s.Label, Sha: s.SHA}
}

// readError is projectError for a read a caller, the model among them, sends: a refusal
// keeps its message, which holds only what the caller sent, and anything else goes to the
// log, since git's own failure names the command and the directory.
func readError(ctx context.Context, err error) error {
	e := projectError(err)
	switch connect.CodeOf(e) {
	case connect.CodeNotFound, connect.CodeInvalidArgument, connect.CodeFailedPrecondition:
		return e
	case connect.CodeCanceled: // a view moved on
	default:
		slog.ErrorContext(ctx, "reading a comparison", "err", err)
	}
	return connect.NewError(connect.CodeOf(e), errors.New("git could not read this comparison"))
}

// CompareWorktree lists what differs between two sources of a worktree.
func (h *Project) CompareWorktree(ctx context.Context, req *connect.Request[v1.CompareWorktreeRequest]) (*connect.Response[v1.CompareWorktreeResponse], error) {
	m := req.Msg
	if m.GetProjectId() == "" || m.GetPath() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("project_id and path are required"))
	}
	base, head, err := compareSides(m.GetBase(), m.GetHead())
	if err != nil {
		return nil, err
	}
	c, err := h.store.CompareWorktree(ctx, project.CompareRequest{ProjectID: m.GetProjectId(), Path: m.GetPath(), Base: base, Head: head, Paths: m.GetPaths()})
	if err != nil {
		return nil, readError(ctx, err)
	}
	files := make([]*v1.CompareFile, len(c.Files))
	for i, f := range c.Files {
		files[i] = &v1.CompareFile{Path: f.Path, OldPath: f.OldPath, Status: f.Status, Added: int32(f.Added), Deleted: int32(f.Deleted), Binary: f.Binary, Submodule: f.Submodule}
	}
	return connect.NewResponse(&v1.CompareWorktreeResponse{
		Files: files, Truncated: c.Truncated,
		TotalFiles: int32(c.TotalFiles), TotalAdded: int32(c.TotalAdded), TotalDeleted: int32(c.TotalDeleted),
		Base: resolvedSourceToProto(c.Base), Head: resolvedSourceToProto(c.Head),
		BaseRef: c.BaseRef, MergeBase: c.MergeBase, Error: c.Error, SkippedNames: int32(c.SkippedNames), UnmatchedPaths: c.UnmatchedPaths,
	}), nil
}

// GetWorktreeCompareFile returns both sides of one file of a comparison.
func (h *Project) GetWorktreeCompareFile(ctx context.Context, req *connect.Request[v1.GetWorktreeCompareFileRequest]) (*connect.Response[v1.GetWorktreeCompareFileResponse], error) {
	m := req.Msg
	if m.GetProjectId() == "" || m.GetPath() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("project_id and path are required"))
	}
	base, head, err := compareSides(m.GetBase(), m.GetHead())
	if err != nil {
		return nil, err
	}
	d, err := h.store.CompareFile(ctx, project.CompareFileRequest{ProjectID: m.GetProjectId(), Path: m.GetPath(), Base: base, Head: head, File: m.GetFile(), OldPath: m.GetOldPath()})
	if err != nil {
		return nil, readError(ctx, err)
	}
	return connect.NewResponse(&v1.GetWorktreeCompareFileResponse{Old: fileVersionToProto(d.Old), New: fileVersionToProto(d.New), Status: d.Status, Error: d.Error}), nil
}

// ListCompareCommits lists the commits of a comparison.
func (h *Project) ListCompareCommits(ctx context.Context, req *connect.Request[v1.ListCompareCommitsRequest]) (*connect.Response[v1.ListCompareCommitsResponse], error) {
	m := req.Msg
	if m.GetProjectId() == "" || m.GetPath() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("project_id and path are required"))
	}
	base, head, err := compareSides(m.GetBase(), m.GetHead())
	if err != nil {
		return nil, err
	}
	l, err := h.store.CompareCommits(ctx, project.CompareCommitsRequest{ProjectID: m.GetProjectId(), Path: m.GetPath(), Base: base, Head: head})
	if err != nil {
		return nil, readError(ctx, err)
	}
	commits := make([]*v1.CompareCommit, len(l.Commits))
	for i, c := range l.Commits {
		commits[i] = &v1.CompareCommit{Sha: c.SHA, ShortSha: c.ShortSHA, Parent: c.Parent, Subject: c.Subject, Body: c.Body, AuthoredAt: timestamppb.New(c.AuthoredAt)}
	}
	return connect.NewResponse(&v1.ListCompareCommitsResponse{Commits: commits, Total: int32(l.Total), Error: l.Error}), nil
}
