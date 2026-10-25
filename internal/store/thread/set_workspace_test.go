package thread

import (
	"errors"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// SetWorkspace sets the reference by id or name, keeps the set, is a no-op when
// unchanged, clears it, refuses an unknown workspace, and refuses to clear or change it
// on a thread that runs in its workspace's folder. Persisted.
func TestSetWorkspace(t *testing.T) {
	e := newWSEnv(t)
	e.ws.Put(workspace.Workspace{ID: "w-shop", Name: "shop", Members: []string{"r1", "r2"}, DefaultPrimary: "r1"})
	plain := e.createIn(CreateOptions{ProjectIDs: []string{"r1", "r2"}})
	inFolder := e.createIn(CreateOptions{WorkspaceID: "login", ProjectID: workspace.PrimaryWorkspace})

	tests := []struct {
		name    string
		id, ref string
		wantWS  string
		wantErr error
	}{
		{name: "by id", id: plain.ID, ref: "w-login", wantWS: "w-login"},
		{name: "unchanged", id: plain.ID, ref: "w-login", wantWS: "w-login"},
		{name: "by name, any case", id: plain.ID, ref: " SHOP ", wantWS: "w-shop"},
		{name: "unknown", id: plain.ID, ref: "nope", wantErr: ErrNotFound},
		{name: "clear", id: plain.ID, ref: "", wantWS: ""},
		{name: "unknown thread", id: "s-nope", ref: "login", wantErr: ErrNotFound},
		{name: "in its folder: the same is fine", id: inFolder.ID, ref: "login", wantWS: "w-login"},
		{name: "in its folder: no change", id: inFolder.ID, ref: "shop", wantErr: ErrFailedPrecondition},
		{name: "in its folder: no clear", id: inFolder.ID, ref: "", wantErr: ErrFailedPrecondition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := e.m.SetWorkspace(e.ctx(), tt.id, tt.ref)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.WorkspaceID != tt.wantWS || !slices.Equal(got.ProjectIDs, []string{"r1", "r2"}) {
				t.Errorf("thread = workspace %q projects %v; want %q, r1 and r2", got.WorkspaceID, got.ProjectIDs, tt.wantWS)
			}
		})
	}

	if _, err := e.m.SetWorkspace(e.ctx(), plain.ID, "shop"); err != nil {
		t.Fatal(err)
	}
	e.restart(e.withSource)
	if got, err := e.m.Get(e.ctx(), plain.ID); err != nil || got.WorkspaceID != "w-shop" {
		t.Errorf("after restart = %q, %v; want w-shop", got.WorkspaceID, err)
	}
}
