package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Resident threads before anything makes them (docs/notes/ember-1-primitives.md): a
// development aid until the resident agent's own store (Ember) does.
// CODE_FOUNDRY_DEV_RESIDENTS lists names ("ember,scout"); each gets its resident thread
// (thread.Manager.EnsureResident) in <home>/residents/<name> at startup. Unset: none.

// devResidentsEnv names the variable.
const devResidentsEnv = "CODE_FOUNDRY_DEV_RESIDENTS"

// residentStore is the slice of the thread store ensureDevResidents needs.
type residentStore interface {
	EnsureResident(ctx context.Context, name string, o thread.ResidentOptions) (thread.Thread, bool, error)
}

// ensureDevResidents makes the residents CODE_FOUNDRY_DEV_RESIDENTS names; failures are
// logged.
func ensureDevResidents(ctx context.Context, log *slog.Logger, threads residentStore, p paths.Paths) {
	for name := range strings.SplitSeq(os.Getenv(devResidentsEnv), ",") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		t, created, err := threads.EnsureResident(ctx, name, thread.ResidentOptions{Cwd: filepath.Join(p.Residents(), name)})
		if err != nil {
			log.Warn("development resident thread", "env", devResidentsEnv, "resident", name, "err", err)
			continue
		}
		log.Info("development resident thread", "env", devResidentsEnv, "resident", name, "thread", t.ID, "created", created)
	}
}
