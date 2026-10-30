package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/presence"
	"github.com/alexwaumann/code-foundry/internal/store/dictation"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Dictation (docs/notes/dictation-2-daemon.md): the store keeps the model in
// <home>/dictation/models, runs the engine (code-foundry-dictate, beside this executable)
// while dictation.enabled is on (live: every settings change calls ConfigChanged), and
// unloads the model while the user is away (presence). A finished download turns
// dictation.enabled on. The model downloads from GitHub through gh first, then Hugging
// Face (docs/notes/dictation-6-model-mirror.md).

// EnvDictateBin overrides where the engine is found (development: a build in another
// worktree, or a stand-in).
const EnvDictateBin = "CODE_FOUNDRY_DICTATE_BIN"

// dictateBinName is the engine's executable, installed next to code-foundry.
const dictateBinName = "code-foundry-dictate"

// dictateBin is the engine's path: $CODE_FOUNDRY_DICTATE_BIN, else beside the running
// executable.
func dictateBin() string {
	if p := os.Getenv(EnvDictateBin); p != "" {
		return p
	}
	return filepath.Join(update.RunningDir(), dictateBinName)
}

// openDictation opens the dictation store and keeps it on the settings and presence.
func openDictation(log *slog.Logger, p paths.Paths, b *bus.Bus, st *settings.Store, pres *presence.Tracker) *dictation.Store {
	bin := dictateBin()
	d := dictation.New(dictation.Options{
		Dir: p.DictationModels(), Bus: b, Log: log,
		Enabled: func() bool { return st.Settings().Dictation.Enabled },
		Enable: func() error {
			_, err := st.Update(context.Background(), map[string]string{settings.KeyDictationEnabled: "true"})
			return err
		},
		Attended: func() bool { return pres.Current().Attended },
		Launch:   dictation.ProcessLauncher(bin, log),
		// The model's GitHub source goes through the user's gh, like the updater.
		Gh: dictation.ExecGh{Path: func() string { return settings.ExpandedPath(st.Settings().Advanced.GhPath) }},
	})
	st.OnChange(func(*settings.Snapshot) { d.ConfigChanged() })
	pres.Subscribe(func(from, to presence.State) {
		if from.Attended != to.Attended {
			d.AttendedChanged(to.Attended)
		}
	})
	log.Debug("dictation engine", "path", bin)
	return d
}
