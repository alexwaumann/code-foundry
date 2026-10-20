package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// skillSetupExits is the skill store's SetupExited (*skill.Store).
type skillSetupExits interface {
	SetupExited(ctx context.Context, name string, code int) error
}

// startSkillSetupExits tells the skill store when a skill's setup terminal (skill.setup,
// termlabel.KindSetup) exits, once per terminal, so an exit 0 records the setup as done
// (docs/notes/skills-2-lifecycle.md). The pattern is startPluginTerminalExits'.
func startSkillSetupExits(ctx context.Context, log *slog.Logger, terms terminal.Store, skills skillSetupExits) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	events, err := terms.Watch(ctx)
	if err != nil {
		log.Warn("skill setup exits: watch terminals", "err", err)
		cancel()
		return func() {}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		told := map[string]bool{}
		for {
			select {
			case <-ctx.Done():
				return
			case ev, ok := <-events:
				if !ok {
					return
				}
				switch t := ev.Updated; {
				case ev.RemovedID != "":
					delete(told, ev.RemovedID)
				case t != nil && t.State == terminal.StateExited && termlabel.IsSetup(t.Labels) && !told[t.ID]:
					told[t.ID] = true
					name := t.Labels[termlabel.Skill]
					if err := skills.SetupExited(ctx, name, t.ExitCode); err != nil && ctx.Err() == nil {
						log.Warn("record skill setup", "skill", name, "terminal", t.ID, "exit", t.ExitCode, "err", err)
					}
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
