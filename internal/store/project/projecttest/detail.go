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

// SetDetail sets what WorktreeDetail returns for d.RepoID and d.Path and publishes
// repo.WorktreeDetailUpdated.
func (f *Fake) SetDetail(d project.WorktreeDetail) {
	f.mu.Lock()
	f.detailMap()[d.ProjectID+"\x00"+d.Path] = d
	f.mu.Unlock()
	f.publish(project.WorktreeDetailUpdated{ProjectID: d.ProjectID, Path: d.Path, ComputedAt: d.ComputedAt})
}

// WorktreeDetail implements repo.Store. A known worktree without a SetDetail returns
// an empty detail.
func (f *Fake) WorktreeDetail(_ context.Context, projectID, path string) (project.WorktreeDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "WorktreeDetail "+projectID+" "+path)
	if d, ok := f.detailMap()[projectID+"\x00"+path]; ok {
		return d, nil
	}
	if _, ok := f.snap.Worktree(projectID, path); !ok {
		return project.WorktreeDetail{}, fmt.Errorf("%w: worktree %q in repo %q", project.ErrNotFound, path, projectID)
	}
	return project.WorktreeDetail{ProjectID: projectID, Path: path}, nil
}
