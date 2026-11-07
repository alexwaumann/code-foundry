package api

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/project/projecttest"
)

func TestCompareWorktreeMaps(t *testing.T) {
	fake, c := newProjectServer(t)
	ctx := context.Background()
	if _, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"})); err != nil {
		t.Fatal(err)
	}
	id := projecttest.ID("/code/proj")
	fake.SetCompare(project.WorktreeCompare{
		Files:      []project.CompareChange{{Path: "b", OldPath: "a", Status: "R", Added: 2, Deleted: 1, Binary: true, Submodule: true}},
		Truncated:  true,
		TotalFiles: 3, TotalAdded: 4, TotalDeleted: 5,
		Base:    project.ResolvedSource{Kind: project.SourceMergeBase, Label: "origin/main", SHA: "aaa"},
		Head:    project.ResolvedSource{Kind: project.SourceWorkingTree, Label: "Working tree"},
		BaseRef: "origin/main", MergeBase: "aaa", SkippedNames: 6,
	}, project.CompareSides{Old: project.FileVersion{Present: true, Submodule: true, Contents: []byte("x")}, Status: "D"})

	res, err := c.CompareWorktree(ctx, connect.NewRequest(&v1.CompareWorktreeRequest{ProjectId: id, Path: "/code/proj"}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg
	f := m.GetFiles()[0]
	if f.GetPath() != "b" || f.GetOldPath() != "a" || f.GetStatus() != "R" || f.GetAdded() != 2 || f.GetDeleted() != 1 || !f.GetBinary() || !f.GetSubmodule() {
		t.Errorf("file = %v", f)
	}
	if !m.GetTruncated() || m.GetTotalFiles() != 3 || m.GetTotalAdded() != 4 || m.GetTotalDeleted() != 5 || m.GetSkippedNames() != 6 {
		t.Errorf("totals = %v", m)
	}
	if b := m.GetBase(); b.GetKind() != v1.DiffSourceKind_DIFF_SOURCE_KIND_MERGE_BASE || b.GetLabel() != "origin/main" || b.GetSha() != "aaa" {
		t.Errorf("base = %v", b)
	}
	if h := m.GetHead(); h.GetKind() != v1.DiffSourceKind_DIFF_SOURCE_KIND_WORKING_TREE || h.GetLabel() != "Working tree" {
		t.Errorf("head = %v", h)
	}
	side, err := c.GetWorktreeCompareFile(ctx, connect.NewRequest(&v1.GetWorktreeCompareFileRequest{ProjectId: id, Path: "/code/proj", File: "b", OldPath: "a"}))
	if err != nil {
		t.Fatal(err)
	}
	if o := side.Msg.GetOld(); !o.GetPresent() || !o.GetSubmodule() || string(o.GetContents()) != "x" || side.Msg.GetStatus() != "D" {
		t.Errorf("sides = %v", side.Msg)
	}
}

// TestCompareSidesDefault: an unset side is the Changes list's; a set one reaches the store.
func TestCompareSidesDefault(t *testing.T) {
	ref := func(s string) *v1.DiffSource {
		return &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_REF, Ref: s}
	}
	staged := &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_STAGED}
	tests := []struct {
		name       string
		base, head *v1.DiffSource
		want       string
	}{
		{"unset", nil, nil, "0: 1:"},
		{"empty messages", &v1.DiffSource{}, &v1.DiffSource{}, "0: 1:"},
		{"refs", ref("main"), ref("HEAD"), "3:main 3:HEAD"},
		{"staged to ref", staged, ref("v1"), "2: 3:v1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake, c := newProjectServer(t)
			ctx := context.Background()
			if _, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"})); err != nil {
				t.Fatal(err)
			}
			id := projecttest.ID("/code/proj")
			if _, err := c.CompareWorktree(ctx, connect.NewRequest(&v1.CompareWorktreeRequest{ProjectId: id, Path: "/code/proj", Base: tt.base, Head: tt.head, Paths: []string{"a"}})); err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprintf("CompareWorktree %s /code/proj %s [a]", id, tt.want)
			if !slices.Contains(fake.Calls, want) {
				t.Errorf("calls = %q, want %q", fake.Calls, want)
			}
		})
	}
}

func TestCompareRefusalCodes(t *testing.T) {
	_, c := newProjectServer(t)
	ctx := context.Background()
	if _, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"})); err != nil {
		t.Fatal(err)
	}
	id := projecttest.ID("/code/proj")
	tests := []struct {
		name string
		req  *v1.CompareWorktreeRequest
		want connect.Code
	}{
		{"no project", &v1.CompareWorktreeRequest{Path: "/code/proj"}, connect.CodeInvalidArgument},
		{"no path", &v1.CompareWorktreeRequest{ProjectId: id}, connect.CodeInvalidArgument},
		{"an unknown kind", &v1.CompareWorktreeRequest{ProjectId: id, Path: "/code/proj", Base: &v1.DiffSource{Kind: 99}}, connect.CodeInvalidArgument},
		{"an unknown worktree", &v1.CompareWorktreeRequest{ProjectId: id, Path: "/nope"}, connect.CodeNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := c.CompareWorktree(ctx, connect.NewRequest(tt.req)); connect.CodeOf(err) != tt.want {
				t.Errorf("CompareWorktree err = %v, want %v", err, tt.want)
			}
			file := &v1.GetWorktreeCompareFileRequest{ProjectId: tt.req.GetProjectId(), Path: tt.req.GetPath(), Base: tt.req.GetBase(), File: "a"}
			if _, err := c.GetWorktreeCompareFile(ctx, connect.NewRequest(file)); connect.CodeOf(err) != tt.want {
				t.Errorf("GetWorktreeCompareFile err = %v, want %v", err, tt.want)
			}
		})
	}
}

// TestReadErrorHidesGit: a caller gets what it sent back, and never the command or
// directory of a git that failed.
func TestReadErrorHidesGit(t *testing.T) {
	gitErr := &project.GitError{Dir: "/Users/someone/repo", Args: []string{"cat-file", "blob", "^abc"}, ExitCode: 128, Stderr: "fatal: not valid"}
	tests := []struct {
		name string
		err  error
		code connect.Code
		want string // in the message
		hide []string
	}{
		{"git failed", gitErr, connect.CodeInternal, "git could not read", []string{"cat-file", "/Users/someone", "^abc", "fatal"}},
		{"git failed, wrapped", fmt.Errorf("reading: %w", gitErr), connect.CodeInternal, "git could not read", []string{"cat-file", "/Users/someone"}},
		{"an os error", fmt.Errorf("project: read /Users/someone/repo: %w", os.ErrPermission), connect.CodeInternal, "git could not read", []string{"/Users/someone"}},
		{"timed out", fmt.Errorf("%w: %w", context.DeadlineExceeded, gitErr), connect.CodeDeadlineExceeded, "git could not read", []string{"cat-file"}},
		{"cancelled", fmt.Errorf("%w: %w", context.Canceled, gitErr), connect.CodeCanceled, "git could not read", []string{"cat-file"}},
		{"a refusal", fmt.Errorf("%w: ref %q cannot start with ^", project.ErrInvalidArgument, "^HEAD"), connect.CodeInvalidArgument, "cannot start with ^", nil},
		{"unknown", fmt.Errorf("%w: worktree", project.ErrNotFound), connect.CodeNotFound, "worktree", nil},
		{"not git", fmt.Errorf("%w: %w", project.ErrFailedPrecondition, project.ErrNotGit), connect.CodeFailedPrecondition, "", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := readError(context.Background(), tt.err)
			if c := connect.CodeOf(got); c != tt.code {
				t.Errorf("code = %v, want %v", c, tt.code)
			}
			if !strings.Contains(got.Error(), tt.want) {
				t.Errorf("message %q, want %q", got, tt.want)
			}
			for _, h := range tt.hide {
				if strings.Contains(got.Error(), h) {
					t.Errorf("message %q holds %q", got, h)
				}
			}
		})
	}
}

// The commits of a comparison map as they are, and an unset side is the list's default.
func TestListCompareCommitsMaps(t *testing.T) {
	fake, c := newProjectServer(t)
	ctx := context.Background()
	if _, err := c.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: "/code/proj"})); err != nil {
		t.Fatal(err)
	}
	id := projecttest.ID("/code/proj")
	at := time.Unix(1000, 0)
	fake.SetCompareCommits(project.CompareLog{Total: 7, Commits: []project.CompareCommit{{SHA: "s", ShortSHA: "sh", Parent: "p", Subject: "sub", Body: "b", AuthoredAt: at}}})
	res, err := c.ListCompareCommits(ctx, connect.NewRequest(&v1.ListCompareCommitsRequest{ProjectId: id, Path: "/code/proj",
		Base: &v1.DiffSource{Kind: v1.DiffSourceKind_DIFF_SOURCE_KIND_REF, Ref: "main"}}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg.GetCommits()[0]
	if res.Msg.GetTotal() != 7 || m.GetSha() != "s" || m.GetShortSha() != "sh" || m.GetParent() != "p" || m.GetSubject() != "sub" || m.GetBody() != "b" || !m.GetAuthoredAt().AsTime().Equal(at) {
		t.Errorf("response = %v", res.Msg)
	}
	want := fmt.Sprintf("CompareCommits %s /code/proj %d:main %d:", id, project.SourceRef, project.SourceWorkingTree)
	if !slices.Contains(fake.Calls, want) {
		t.Errorf("calls = %q, want %q", fake.Calls, want)
	}
	if _, err := c.ListCompareCommits(ctx, connect.NewRequest(&v1.ListCompareCommitsRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("no project: %v", err)
	}
}
