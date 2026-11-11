package commandtest

import (
	"context"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/pluginscaffold"
)

// PluginScaffolder is a fake command.PluginScaffolder: New records its arguments and
// answers Res, or Err when set.
type PluginScaffolder struct {
	Res                 pluginscaffold.Result
	Err                 error
	Name, Parent, Owner string
}

var _ command.PluginScaffolder = (*PluginScaffolder)(nil)

// New implements command.PluginScaffolder.
func (f *PluginScaffolder) New(_ context.Context, name, parent, owner string) (pluginscaffold.Result, error) {
	f.Name, f.Parent, f.Owner = name, parent, owner
	return f.Res, f.Err
}
