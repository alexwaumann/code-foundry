package daemon

import (
	"context"
	"database/sql"
	"log/slog"
	"path/filepath"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// Ember, the resident agent (docs/notes/ember-2-store.md): its store lives in
// <home>/residents/ember, reads the ember.* settings through emberConfig (live: every
// settings change calls ConfigChanged), hooks its worker defaults and its permission
// rules into the thread store, and writes its own skill (code-foundry-ember) into its
// skills directory.

// emberConfig maps the settings onto the Ember store's Config.
func emberConfig(s settings.Settings) ember.Config {
	return ember.Config{
		Enabled: s.Ember.Enabled, Model: s.Ember.Model, Effort: s.Ember.Effort,
		WorkerModels: settings.SplitList(s.Ember.WorkerModels), WorkerEffort: s.Ember.WorkerEffort,
		EpochContextTokens: s.Ember.EpochContextTokens, EpochMaxHours: s.Ember.EpochMaxHours,
	}
}

// installEmberSkill writes Ember's skill under dir (dir/.claude/skills), like the
// skills every thread gets.
func installEmberSkill(dir string) error {
	v := version.Get()
	files, err := skills.EmberFiles(skills.Sources{Version: v.Version, Commit: v.Commit})
	if err != nil {
		return err
	}
	return skills.Install(dir, v.Version, files)
}

// openEmber opens the Ember store and keeps it on the settings.
func openEmber(ctx context.Context, log *slog.Logger, p paths.Paths, db *sql.DB, b *bus.Bus, st *settings.Store,
	threads *thread.Manager, projects *project.Git, claude string) (*ember.Store, error) {
	e, err := ember.New(ctx, ember.Options{
		DB: db, Bus: b, Log: log, Threads: threads, Projects: projects, Dir: filepath.Join(p.Residents(), ember.Name),
		Config:       func() ember.Config { return emberConfig(st.Settings()) },
		Claude:       claude,
		InstallSkill: installEmberSkill,
		// installSkills writes every thread's skills there (p.Claude(), the first add-dir).
		OrchestrateSkill: filepath.Join(p.Claude(), skills.SkillsDir, skills.Orchestrate),
	})
	if err != nil {
		return nil, err
	}
	st.OnChange(func(*settings.Snapshot) { e.ConfigChanged() })
	return e, nil
}
