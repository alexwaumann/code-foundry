package repotest

import (
	"context"
	"fmt"

	"github.com/awaumann/code-foundry/internal/store/repo"
)

func (f *Fake) detailMap() map[string]repo.WorktreeDetail {
	if f.details == nil {
		f.details = map[string]repo.WorktreeDetail{}
	}
	return f.details
}

// SetDetail sets what WorktreeDetail returns for d.RepoID and d.Path and publishes
// repo.WorktreeDetailUpdated.
func (f *Fake) SetDetail(d repo.WorktreeDetail) {
	f.mu.Lock()
	f.detailMap()[d.RepoID+"\x00"+d.Path] = d
	f.mu.Unlock()
	f.publish(repo.WorktreeDetailUpdated{RepoID: d.RepoID, Path: d.Path, ComputedAt: d.ComputedAt})
}

// WorktreeDetail implements repo.Store. A known worktree without a SetDetail returns
// an empty detail.
func (f *Fake) WorktreeDetail(_ context.Context, repoID, path string) (repo.WorktreeDetail, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "WorktreeDetail "+repoID+" "+path)
	if d, ok := f.detailMap()[repoID+"\x00"+path]; ok {
		return d, nil
	}
	if _, ok := f.snap.Worktree(repoID, path); !ok {
		return repo.WorktreeDetail{}, fmt.Errorf("%w: worktree %q in repo %q", repo.ErrNotFound, path, repoID)
	}
	return repo.WorktreeDetail{RepoID: repoID, Path: path}, nil
}
