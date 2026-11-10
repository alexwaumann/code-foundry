package projecttest

import "strings"

// SetLiveWorktrees implements project.Store by recording the call ("SetLiveWorktrees a,b").
func (f *Fake) SetLiveWorktrees(paths []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, "SetLiveWorktrees "+strings.Join(paths, ","))
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
