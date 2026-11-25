package project

import (
	"context"
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

func TestNewExecRunnerPrecomputesEnv(t *testing.T) {
	t.Setenv("CF_TEST_PRECOMPUTED_ENV", "yes")
	r := NewExecRunner()
	if !slices.Contains(r.env, "CF_TEST_PRECOMPUTED_ENV=yes") || !slices.Contains(r.env, "LC_ALL=C") || !slices.Contains(r.env, "GIT_PAGER=cat") {
		t.Fatalf("r.env missing expected entries: %v", r.env)
	}
	if slices.Contains(r.env, "GIT_NO_LAZY_FETCH=1") {
		t.Fatal("r.env should not contain GIT_NO_LAZY_FETCH=1")
	}
	if !slices.Contains(r.guardedEnv, "GIT_NO_LAZY_FETCH=1") {
		t.Fatal("r.guardedEnv missing GIT_NO_LAZY_FETCH=1")
	}
	// Runs git cleanly in both normal and guarded modes.
	if _, err := r.Run(context.Background(), t.TempDir(), "--version"); err != nil {
		t.Fatalf("Run --version: %v", err)
	}
	if _, err := r.Run(guarded(context.Background()), t.TempDir(), "--version"); err != nil {
		t.Fatalf("guarded Run --version: %v", err)
	}
}
