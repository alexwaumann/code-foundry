package daemon

import (
	"cmp"
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// The Skills marketplace (docs/notes/skills-1-registry.md): the store reading the
// marketplaces Claude Code has, its start-up read and its hourly refresh.

// newSkillStore builds the skill store. claude is advanced.claude_path, else "claude"
// from PATH (the thread store's rule), read on every call so the setting applies live.
// Skills install into Claude Code's user skills dir ($CLAUDE_CONFIG_DIR/skills, else
// ~/.claude/skills); disabled ones wait in <home>/skills/disabled.
func newSkillStore(p paths.Paths, db *sql.DB, b *bus.Bus, st *settings.Store, log *slog.Logger) (*skill.Store, error) {
	cp, err := thread.DefaultClaudePaths()
	if err != nil {
		return nil, fmt.Errorf("skill store: %w", err)
	}
	return skill.New(skill.Options{
		DB: db, Bus: b, Log: log,
		Claude: skill.ExecClaude{Path: func() string {
			return cmp.Or(settings.ExpandedPath(st.Settings().Advanced.ClaudePath), "claude")
		}},
		SkillsDir:   filepath.Join(cp.Dir, "skills"),
		DisabledDir: p.DisabledSkills(),
	})
}

// skillLoader is the part of *skill.Store the daemon drives.
type skillLoader interface {
	Load(ctx context.Context) error
	Refresh(ctx context.Context) error
}

// startSkills reads the marketplaces once at start from the checkouts Claude Code has
// (no network), then refreshes them on the plugin registry's tick (onUpdateChecks:
// `claude plugin marketplace update` per marketplace, then a re-read). stop waits for
// a read or refresh in flight.
func startSkills(ctx context.Context, log *slog.Logger, b *bus.Bus, u update.Service, skills skillLoader) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Go(func() {
		if err := skills.Load(ctx); err != nil && ctx.Err() == nil {
			log.Warn("skill marketplaces read with errors", "err", err)
		}
	})
	stopTicks := onUpdateChecks(ctx, b, u, func(ctx context.Context) {
		err := skills.Refresh(ctx)
		switch {
		case ctx.Err() != nil:
		case err != nil:
			log.Warn("skill marketplace refresh failed", "err", err)
		default:
			log.Info("skill marketplaces refreshed")
		}
	})
	return func() {
		cancel()
		stopTicks()
		wg.Wait()
	}
}
