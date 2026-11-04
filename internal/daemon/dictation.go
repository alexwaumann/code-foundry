package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/dictate"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/dictation"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// Dictation (docs/notes/dictation-2-daemon.md): the store keeps the model in
// <home>/dictation/models, runs the engine (code-foundry-dictate, beside this executable)
// while dictation.enabled is on (live: every settings change calls ConfigChanged) and
// keeps the model loaded. A finished download turns dictation.enabled on. The model
// downloads from GitHub through gh first, then Hugging
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

// openDictation opens the dictation store and keeps it on the settings.
func openDictation(log *slog.Logger, p paths.Paths, b *bus.Bus, st *settings.Store) *dictation.Store {
	bin := dictateBin()
	d := dictation.New(dictation.Options{
		Dir: p.DictationModels(), Bus: b, Log: log,
		Enabled: func() bool { return st.Settings().Dictation.Enabled },
		Prefs: func() dictation.Prefs {
			all := st.Settings()
			s := all.Dictation
			return dictation.Prefs{
				Anywhere: s.Anywhere, HoldKey: s.HoldKey, Sounds: s.Sounds, SoundVolume: all.Notifications.SoundVolume,
				OtherAudio: s.OtherAudio, Microphone: s.Microphone, AvoidBluetooth: s.AvoidBluetooth,
				Spoken: dictate.Spoken{Symbols: s.SpokenSymbols, Formatting: s.SpokenFormatting},
			}
		},
		Enable: func() error {
			_, err := st.Update(context.Background(), map[string]string{settings.KeyDictationEnabled: "true"})
			return err
		},
		Launch: dictation.ProcessLauncher(bin, log),
		// The model's GitHub source goes through the user's gh, like the updater.
		Gh: dictation.ExecGh{Path: func() string { return settings.ExpandedPath(st.Settings().Advanced.GhPath) }},
	})
	st.OnChange(func(*settings.Snapshot) { d.ConfigChanged() })
	log.Debug("dictation engine", "path", bin)
	return d
}
