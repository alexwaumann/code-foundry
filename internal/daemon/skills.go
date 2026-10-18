package daemon

import (
	"context"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/skills"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// installSkills renders the skills every thread gets (internal/skills) from this
// daemon's commands and settings schema and writes them to dir (paths.Paths.Claude,
// every claude's first --add-dir; the thread store creates it). Called once at start,
// before the servers listen, so no thread starts meanwhile. A failure is logged: threads
// work without the skills.
func installSkills(ctx context.Context, log *slog.Logger, dir, version string, cmds *api.Command, set *api.Settings, st *settings.Store) {
	files, err := renderSkills(ctx, version, cmds, set, st)
	if err == nil {
		err = skills.Install(dir, version, files)
	}
	if err != nil {
		log.Error("threads get no code-foundry skills", "dir", dir, "err", err)
		return
	}
	log.Info("skills installed", "dir", dir, "files", len(files))
}

// renderSkills lists the commands (unavailable ones too, as `code-foundry guide` does)
// and the settings schema, and renders the skills from them.
func renderSkills(ctx context.Context, version string, cmds *api.Command, set *api.Settings, st *settings.Store) (skills.Files, error) {
	listed, err := cmds.List(ctx, connect.NewRequest(&v1.ListCommandsRequest{IncludeUnavailable: true}))
	if err != nil {
		return nil, fmt.Errorf("list commands: %w", err)
	}
	schema, err := set.GetSchema(ctx, connect.NewRequest(&v1.GetSettingsSchemaRequest{}))
	if err != nil {
		return nil, fmt.Errorf("settings schema: %w", err)
	}
	commands := listed.Msg.GetCommands()
	dropSettingDefaults(commands, registryOverrides(st.Settings()).ArgDefaults)
	return skills.Render(skills.Sources{
		Version: version, Commands: commands,
		SettingGroups: schema.Msg.GetGroups(), Settings: schema.Msg.GetFields(),
	})
}

// dropSettingDefaults clears the defaults the settings put on args (thread.new's model
// and effort): the files are written once per start, and a value read then would go
// stale with the next settings change. The arg's description still names the setting.
func dropSettingDefaults(cmds []*v1.Command, fromSettings map[string]map[string]string) {
	for _, c := range cmds {
		defs := fromSettings[c.GetName()]
		for _, a := range c.GetArgs() {
			if _, ok := defs[a.GetName()]; ok {
				a.DefaultValue = ""
			}
		}
	}
}
