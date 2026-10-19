package projecttest

import "github.com/alexwaumann/code-foundry/internal/store/project"

// FilesChanged publishes ev, as the store does when a live worktree's tree window
// closes. The snapshot is unchanged.
func (f *Fake) FilesChanged(ev project.WorktreeFilesChanged) { f.publish(ev) }
