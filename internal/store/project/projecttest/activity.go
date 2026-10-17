package projecttest

import (
	"slices"
	"strings"
)

// SetLiveWorktrees implements project.Store: it records the set (LiveWorktrees) and the
// call ("SetLiveWorktrees a,b").
func (f *Fake) SetLiveWorktrees(paths []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.live = slices.Clone(paths)
	f.Calls = append(f.Calls, "SetLiveWorktrees "+strings.Join(paths, ","))
}

// LiveWorktrees returns the paths the last SetLiveWorktrees named.
func (f *Fake) LiveWorktrees() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.live)
}

// Touch implements project.Store by recording "Touch <path>".
func (f *Fake) Touch(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "Touch "+path)
}

// TouchNow implements project.Store by recording "TouchNow <path>".
func (f *Fake) TouchNow(path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "TouchNow "+path)
}
