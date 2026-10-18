package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// plugin.env (docs/notes/plugins-3-events-flags-env.md): what plugins contribute to new
// Claude threads (session/setEnvironment), as applied, with the issues found.

// PluginEnvBackend is the slice of PluginService plugin.env needs.
type PluginEnvBackend interface {
	Environment(context.Context, *connect.Request[v1.PluginEnvironmentRequest]) (*connect.Response[v1.PluginEnvironmentResponse], error)
}

func pluginEnvCmd(b PluginBackend) Command {
	return Command{
		Name:  "plugin.env",
		Title: "Show Plugin Session Environment",
		Description: "Print what plugins add to new Claude threads: environment variables, PATH entries and --add-dir " +
			"directories, which projects get them, and what was refused or lost to another plugin. One plugin's with a name.",
		Category:     "Plugin",
		NoKeybinding: true,
		Args:         []ArgSpec{{Name: "name", Type: String, Positional: true, Description: "Plugin name (default: every plugin)"}},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.Environment(ctx, connect.NewRequest(&v1.PluginEnvironmentRequest{Name: a.String("name")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: formatPluginEnvs(a.String("name"), res.Msg.GetEnvironments()), JSON: res.Msg}, nil
		},
	}
}

func formatPluginEnvs(name string, envs []*v1.PluginEnvironment) string {
	if len(envs) == 0 {
		if name != "" {
			return "plugin " + name + " adds nothing to new threads"
		}
		return "no plugin adds anything to new threads"
	}
	var blocks []string
	for _, e := range envs {
		lines := []string{"plugin " + e.GetPlugin()}
		scope := "every project"
		if len(e.GetProjects()) > 0 {
			scope = "projects " + strings.Join(e.GetProjects(), ", ")
		}
		if e.GetNoProject() {
			scope += ", and threads without a project"
		}
		lines = append(lines, "  scope: "+scope)
		for _, kv := range e.GetEnv() {
			lines = append(lines, fmt.Sprintf("  env %s=%s", kv.GetKey(), kv.GetValue()))
		}
		for _, p := range e.GetPathPrepend() {
			lines = append(lines, "  PATH += "+p)
		}
		for _, d := range e.GetAddDirs() {
			lines = append(lines, "  --add-dir "+d)
		}
		for _, is := range e.GetIssues() {
			lines = append(lines, "  issue: "+is)
		}
		if at := e.GetUpdatedAt(); at != nil {
			lines = append(lines, "  pushed: "+at.AsTime().Local().Format("2006-01-02 15:04:05"))
		}
		blocks = append(blocks, strings.Join(lines, "\n"))
	}
	return strings.Join(blocks, "\n\n")
}
