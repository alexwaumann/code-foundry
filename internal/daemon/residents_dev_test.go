package daemon

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestEnsureDevResidents(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := paths.New("/cf")
	for _, tt := range []struct {
		value string
		want  []string
	}{
		{"", nil},
		{"ember", []string{"EnsureResident ember " + filepath.Join("/cf", "residents", "ember")}},
		{" ember, ,scout ", []string{"EnsureResident ember /cf/residents/ember", "EnsureResident scout /cf/residents/scout"}},
	} {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv(devResidentsEnv, tt.value)
			fake := threadtest.New(bus.New())
			ensureDevResidents(context.Background(), log, fake, p)
			if got := fake.Calls(); !slices.Equal(got, tt.want) {
				t.Errorf("calls = %q, want %q", got, tt.want)
			}
		})
	}
}
