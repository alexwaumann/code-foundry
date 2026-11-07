package projecttest

import (
	"context"
	"fmt"

	"github.com/alexwaumann/code-foundry/internal/store/project"
)

func (f *Fake) detailMap() map[string]project.WorktreeDetail {
	if f.details == nil {
		f.details = map[string]project.WorktreeDetail{}
	}
	return f.details
}

// SetDetail sets what WorktreeDetail returns for d.ProjectID and d.Path and publishes
// project.WorktreeDetailUpdated.
func (f *Fake) SetDetail(d project.WorktreeDetail) {
	f.mu.Lock()
	f.detailMap()[d.ProjectID+"\x00"+d.Path] = d
	f.mu.Unlock()
	f.publish(project.WorktreeDetailUpdated{ProjectID: d.ProjectID, Path: d.Path, ComputedAt: d.ComputedAt})
}

// WorktreeDetail implements project.Store. A known worktree without a SetDetail returns
// an empty detail.
func (f *Fake) WorktreeDetail(_ context.Context, projectID, path string) (project.WorktreeDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "WorktreeDetail "+projectID+" "+path)
	if d, ok := f.detailMap()[projectID+"\x00"+path]; ok {
		return d, nil
	}
	if _, ok := f.snap.Worktree(projectID, path); !ok {
		return project.WorktreeDetail{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, path, projectID)
	}
	return project.WorktreeDetail{ProjectID: projectID, Path: path}, nil
}

// SetFileDiff sets what WorktreeFileDiff returns for a known worktree.
func (f *Fake) SetFileDiff(d project.WorktreeFileDiff) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fileDiff = d
}

// WorktreeFileDiff implements project.Store: the SetFileDiff value for any file of a
// known worktree.
func (f *Fake) WorktreeFileDiff(_ context.Context, req project.FileDiffRequest) (project.WorktreeFileDiff, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("WorktreeFileDiff %s %s %s %d", req.ProjectID, req.Path, req.File, req.Scope))
	if _, ok := f.snap.Worktree(req.ProjectID, req.Path); !ok {
		return project.WorktreeFileDiff{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, req.Path, req.ProjectID)
	}
	return f.fileDiff, nil
}

// SetCompare sets what CompareWorktree and CompareFile return for a known worktree.
func (f *Fake) SetCompare(c project.WorktreeCompare, sides project.CompareSides) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.compare, f.compareSides = c, sides
}

// CompareWorktree implements project.Store: the SetCompare value for a known worktree.
func (f *Fake) CompareWorktree(_ context.Context, req project.CompareRequest) (project.WorktreeCompare, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("CompareWorktree %s %s %d:%s %d:%s %v", req.ProjectID, req.Path, req.Base.Kind, req.Base.Ref, req.Head.Kind, req.Head.Ref, req.Paths))
	if _, ok := f.snap.Worktree(req.ProjectID, req.Path); !ok {
		return project.WorktreeCompare{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, req.Path, req.ProjectID)
	}
	return f.compare, nil
}

// SetCompareCommits sets what CompareCommits returns for a known worktree.
func (f *Fake) SetCompareCommits(l project.CompareLog) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.compareLog = l
}

// CompareCommits implements project.Store: the SetCompareCommits value for a known worktree.
func (f *Fake) CompareCommits(_ context.Context, req project.CompareCommitsRequest) (project.CompareLog, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("CompareCommits %s %s %d:%s %d:%s", req.ProjectID, req.Path, req.Base.Kind, req.Base.Ref, req.Head.Kind, req.Head.Ref))
	if _, ok := f.snap.Worktree(req.ProjectID, req.Path); !ok {
		return project.CompareLog{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, req.Path, req.ProjectID)
	}
	return f.compareLog, nil
}

// SetCompareCommitBody sets what CompareCommitBody returns for a known worktree.
func (f *Fake) SetCompareCommitBody(m project.CompareCommitMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.commitMessage = m
}

// CompareCommitBody implements project.Store: the SetCompareCommitBody value for a known worktree.
func (f *Fake) CompareCommitBody(_ context.Context, req project.CompareCommitRequest) (project.CompareCommitMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("CompareCommitBody %s %s %s", req.ProjectID, req.Path, req.SHA))
	if _, ok := f.snap.Worktree(req.ProjectID, req.Path); !ok {
		return project.CompareCommitMessage{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, req.Path, req.ProjectID)
	}
	return f.commitMessage, nil
}

// CompareFile implements project.Store: the SetCompare value for any file of a known
// worktree.
func (f *Fake) CompareFile(_ context.Context, req project.CompareFileRequest) (project.CompareSides, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, fmt.Sprintf("CompareFile %s %s %s %s", req.ProjectID, req.Path, req.File, req.OldPath))
	if _, ok := f.snap.Worktree(req.ProjectID, req.Path); !ok {
		return project.CompareSides{}, fmt.Errorf("%w: worktree %q in project %q", project.ErrNotFound, req.Path, req.ProjectID)
	}
	return f.compareSides, nil
}
