package daemon

import (
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// setSettingsCommands tells the settings store which commands reg holds now: their
// keybinding fields, and which keybinding overrides name a command.
func setSettingsCommands(st *settings.Store, reg *command.Registry) {
	listed := reg.List(command.Context{}, true)
	cmds := make([]settings.CommandInfo, len(listed))
	for i, l := range listed {
		cmds[i] = settings.CommandInfo{
			Name: l.Name, Title: l.Title, Description: l.Description, Category: l.Category, Keybindings: l.Keybindings,
			NoKeybinding: l.NoKeybinding,
		}
	}
	st.SetCommands(cmds)
}

// settingsCommandHost is the command registry as the plugin store sees it: whenever a
// plugin's commands come or go (enable, disable, a manifest change), the settings store
// learns the new command list, so a keybinding override of a plugin command applies once
// the plugin registers it (it is kept in the file, reported as an issue, while the
// plugin is off).
type settingsCommandHost struct {
	*command.Registry
	settings *settings.Store
}

var _ plugin.CommandHost = settingsCommandHost{}

// ReplacePrefix replaces the commands under prefix, then updates the settings store.
func (h settingsCommandHost) ReplacePrefix(prefix string, cmds []command.Command) error {
	if err := h.Registry.ReplacePrefix(prefix, cmds); err != nil {
		return err
	}
	setSettingsCommands(h.settings, h.Registry)
	return nil
}
