package daemon

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// ghLocalGitStore is the narrow slice of *project.Git bridged into gh.Store.
type ghLocalGitStore interface {
	LocalDiff(ctx context.Context, slug, baseSHA, headSHA string, maxBytes int) (diff []byte, truncated bool, ok bool)
	LocalCommitFile(ctx context.Context, slug, commitSHA, filePath string, maxBytes int) (contents []byte, truncated, binary, notFound, ok bool)
}

var _ ghLocalGitStore = (*project.Git)(nil)

// ghLocalGitBridge adapts project.Git to gh.LocalGitProvider without introducing any
// import dependency between internal/store/gh and internal/store/project.
type ghLocalGitBridge struct {
	projects ghLocalGitStore
}

var _ gh.LocalGitProvider = (*ghLocalGitBridge)(nil)

func newGhLocalGit(projects ghLocalGitStore) gh.LocalGitProvider {
	if projects == nil {
		return nil
	}
	return &ghLocalGitBridge{projects: projects}
}

func (b *ghLocalGitBridge) LocalPRDiff(ctx context.Context, slug, baseSHA, headSHA string, maxBytes int) ([]byte, bool, bool) {
	return b.projects.LocalDiff(ctx, slug, baseSHA, headSHA, maxBytes)
}

func (b *ghLocalGitBridge) LocalPRFile(ctx context.Context, slug, commitSHA, filePath string, maxBytes int) ([]byte, bool, bool, bool, bool) {
	return b.projects.LocalCommitFile(ctx, slug, commitSHA, filePath, maxBytes)
}
