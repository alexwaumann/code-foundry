package thread

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"testing"
)

// trusted is the folders Claude's config at path marks as trusted.
func trusted(t *testing.T, path string) map[string]bool {
	t.Helper()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Projects map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for k, v := range cfg.Projects {
		out[k] = v.HasTrustDialogAccepted
	}
	return out
}

// A start pre-trusts the cwd and every other member's checkout, a project's own folder
// included, so Run in to any of them is not refused with needs_trust by a running claude
// that has not seen trust written just before set_cwd. With DisablePreTrust nothing is
// written.
func TestSpawnPreTrustsEveryCheckout(t *testing.T) {
	tests := []struct {
		name    string
		disable bool
	}{
		{name: "every member trusted"},
		{name: "pre-trust off", disable: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, rr := multiEnv(t, func(o *Options) { o.DisablePreTrust = tt.disable })
			s := e.create(CreateOptions{ProjectID: "r1", ProjectIDs: []string{"r1", "r2"}, CheckoutMode: true})
			e.waitFor(s.ID, "connected", func(s Thread) bool { return s.State == StateConnected })
			api, _ := rr.Snapshot().Project("r2")
			got := trusted(t, e.paths.Config)
			for _, dir := range []string{s.WorktreePath, mainCheckout(api)} {
				if got[realPath(dir)] == tt.disable {
					t.Errorf("%s trusted = %v, want %v (config %v)", dir, got[realPath(dir)], !tt.disable, got)
				}
			}
		})
	}
}
