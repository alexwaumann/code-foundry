package project

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckName(t *testing.T) {
	snap := &Snapshot{Projects: []Project{
		{ID: "aaaaaaaaaaaa", Name: "web", Path: "/src/web"},
		{ID: "bbbbbbbbbbbb", Name: "api", Path: "/src/api"},
		{ID: "cccccccccccc", Name: "api", Path: "/other/api"}, // two folders, one basename
	}}
	tests := []struct {
		name, id, in, want string
		wantErr            error
	}{
		{name: "trimmed", id: "aaaaaaaaaaaa", in: "  site  ", want: "site"},
		{name: "NFC", id: "aaaaaaaaaaaa", in: "café", want: "café"},
		{name: "own name in another case", id: "aaaaaaaaaaaa", in: "Web", want: "Web"},
		{name: "own id", id: "aaaaaaaaaaaa", in: "aaaaaaaaaaaa", want: "aaaaaaaaaaaa"},
		{name: "a shared name to itself", id: "bbbbbbbbbbbb", in: "api", wantErr: ErrFailedPrecondition},
		{name: "another project's name", id: "aaaaaaaaaaaa", in: "api", wantErr: ErrFailedPrecondition},
		{name: "another project's name in another case", id: "bbbbbbbbbbbb", in: "WEB", wantErr: ErrFailedPrecondition},
		{name: "another project's id", id: "aaaaaaaaaaaa", in: "BBBBBBBBBBBB", wantErr: ErrInvalidArgument},
		{name: "empty", id: "aaaaaaaaaaaa", in: "   ", wantErr: ErrInvalidArgument},
		{name: "too long", id: "aaaaaaaaaaaa", in: strings.Repeat("x", 101), wantErr: ErrInvalidArgument},
		{name: "two lines", id: "aaaaaaaaaaaa", in: "a\nb", wantErr: ErrInvalidArgument},
		{name: "a slash", id: "aaaaaaaaaaaa", in: "web/site", wantErr: ErrInvalidArgument},
		{name: "a comma", id: "aaaaaaaaaaaa", in: "web,site", wantErr: ErrInvalidArgument},
		{name: "tilde", id: "aaaaaaaaaaaa", in: "~", wantErr: ErrInvalidArgument},
		{name: "the keyword", id: "aaaaaaaaaaaa", in: "Workspace", wantErr: ErrInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := CheckName(snap, tt.id, tt.in)
			if !errors.Is(err, tt.wantErr) || (tt.wantErr == nil && got != tt.want) {
				t.Fatalf("CheckName(%q) = %q, %v; want %q, %v", tt.in, got, err, tt.want, tt.wantErr)
			}
		})
	}
}

func TestRenameKeepsNameAndWorktreePaths(t *testing.T) {
	f := newFixture(t)
	git(t, f.project, "remote", "remove", "origin") // local only: worktrees go to _local/<folder>
	dbPath := filepath.Join(t.TempDir(), "db.sqlite")
	h := startHarness(t, dbPath, Options{})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	other, err := h.store.Register(ctx, f.other)
	if err != nil {
		t.Fatal(err)
	}
	wtBefore := h.store.DefaultWorktreePath(r.ID, "feat")

	got, err := h.store.Rename(ctx, r.ID, " Shop ")
	if err != nil || got.Name != "Shop" {
		t.Fatalf("Rename = %+v, %v", got, err)
	}
	h.waitFor("renamed ProjectUpdated", func(ev Event) bool {
		u, ok := ev.(ProjectUpdated)
		return ok && u.Project.ID == r.ID && u.Project.Name == "Shop"
	})
	if _, err := h.store.Rename(ctx, other.ID, "shop"); !errors.Is(err, ErrFailedPrecondition) {
		t.Fatalf("a taken name: %v", err)
	}
	if _, err := h.store.Rename(ctx, "nope", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown project: %v", err)
	}
	// A reconcile after the rename keeps it, and worktrees still go where they went.
	if err := h.store.Refresh(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if p, _ := h.store.Snapshot().Project(r.ID); p.Name != "Shop" {
		t.Fatalf("after refresh: name %q", p.Name)
	}
	if wt := h.store.DefaultWorktreePath(r.ID, "feat"); wt != wtBefore || !strings.Contains(wt, "/_local/proj/") {
		t.Fatalf("worktree path %q, was %q", wt, wtBefore)
	}
	h.close()

	h2 := startHarness(t, dbPath, Options{})
	if p, _ := h2.store.Snapshot().Project(r.ID); p.Name != "Shop" {
		t.Fatalf("reloaded name %q", p.Name)
	}
}
