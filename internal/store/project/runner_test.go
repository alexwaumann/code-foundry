package project

import (
	"slices"
	"testing"
)

func TestGitEnv(t *testing.T) {
	base := []string{
		"HOME=/h", "GIT_DIR=/elsewhere/.git", "GIT_WORK_TREE=/elsewhere", "LC_ALL=de_DE.UTF-8",
		"GIT_PAGER=less", "GIT_TERMINAL_PROMPT=1", "GIT_OPTIONAL_LOCKS=1", "PATH=/bin",
	}
	got := gitEnv(base)
	slices.Sort(got)
	want := []string{"GIT_OPTIONAL_LOCKS=0", "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0", "HOME=/h", "LC_ALL=C", "PATH=/bin"}
	if !slices.Equal(got, want) {
		t.Errorf("gitEnv = %q, want %q", got, want)
	}
}
