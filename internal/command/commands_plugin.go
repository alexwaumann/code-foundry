package command

import (
	"context"
	"fmt"
	"strings"
	"text/tabwriter"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// PluginBackend is the slice of PluginService the plugin.* commands need, in generated
// Connect signatures (see TerminalBackend for why).
type PluginBackend interface {
	List(context.Context, *connect.Request[v1.ListPluginsRequest]) (*connect.Response[v1.ListPluginsResponse], error)
	Enable(context.Context, *connect.Request[v1.EnablePluginRequest]) (*connect.Response[v1.EnablePluginResponse], error)
	Disable(context.Context, *connect.Request[v1.DisablePluginRequest]) (*connect.Response[v1.DisablePluginResponse], error)
	Restart(context.Context, *connect.Request[v1.RestartPluginRequest]) (*connect.Response[v1.RestartPluginResponse], error)
	Dev(context.Context, *connect.Request[v1.DevPluginRequest]) (*connect.Response[v1.DevPluginResponse], error)
	Reload(context.Context, *connect.Request[v1.ReloadPluginsRequest]) (*connect.Response[v1.ReloadPluginsResponse], error)
	Logs(context.Context, *connect.Request[v1.PluginLogsRequest]) (*connect.Response[v1.PluginLogsResponse], error)
	ListSecrets(context.Context, *connect.Request[v1.ListPluginSecretsRequest]) (*connect.Response[v1.ListPluginSecretsResponse], error)
	DeleteSecret(context.Context, *connect.Request[v1.DeletePluginSecretRequest]) (*connect.Response[v1.DeletePluginSecretResponse], error)
}

var (
	_ PluginBackend = codefoundryv1connect.PluginServiceHandler(nil)
	_ PluginBackend = codefoundryv1connect.PluginServiceClient(nil)
)

// pluginByName finds a plugin in the backend's list.
func pluginByName(ctx context.Context, b PluginBackend, name string) (*v1.Plugin, bool) {
	res, err := b.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
	if err != nil {
		return nil, false
	}
	for _, p := range res.Msg.GetPlugins() {
		if p.GetName() == name {
			return p, true
		}
	}
	return nil, false
}

// RegisterPlugin registers the plugin management verbs: plugin.list, plugin.enable,
// plugin.disable, plugin.restart, plugin.reload, plugin.logs, plugin.dev,
// plugin.secrets.list and plugin.secrets.delete. A plugin's own commands
// (plugin.<name>.<command>) come from the plugin store (Registry.ReplacePrefix).
func RegisterPlugin(r *Registry, b PluginBackend) error {
	nameArg := ArgSpec{Name: "name", Type: String, Required: true, Positional: true, Description: "Plugin name (code-foundry plugin list)"}
	followArg := ArgSpec{Name: "follow", Type: Bool, Description: "CLI: keep printing new log lines until interrupted"}
	return r.RegisterAll(
		Command{
			Name:  "plugin.list",
			Title: "List Plugins",
			Description: "List the plugins in ~/.code-foundry/plugins: version, state (disabled, starting, running, crashed, " +
				"failed), whether enabling needs consent, and their commands.",
			Category:     "Plugin",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := b.List(ctx, connect.NewRequest(&v1.ListPluginsRequest{}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatPlugins(res.Msg.GetPlugins()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.enable",
			Title: "Enable Plugin",
			Description: "Enable a plugin: start it and register its commands. The first time, and whenever an update asks " +
				"for more permissions, it lists what the plugin may do and asks for consent (--yes consents).",
			Category: "Plugin",
			Args:     []ArgSpec{nameArg},
			Confirm:  "Enable plugin {name}?",
			ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
				p, ok := pluginByName(ctx, b, a.String("name"))
				return ok && p.GetNeedsConsent()
			},
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
				if p, ok := pluginByName(ctx, b, a.String("name")); ok {
					return p.GetConsentText()
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Enable(ctx, connect.NewRequest(&v1.EnablePluginRequest{Name: a.String("name"), Consent: true}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: enabledMessage(res.Msg.GetPlugin()), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "plugin.disable",
			Title:       "Disable Plugin",
			Description: "Stop a plugin and remove its commands. Its secrets and the consent given stay.",
			Category:    "Plugin",
			Args:        []ArgSpec{nameArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Disable(ctx, connect.NewRequest(&v1.DisablePluginRequest{Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "disabled " + a.String("name"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "plugin.restart",
			Title:       "Restart Plugin",
			Description: "Re-read a plugin's manifest and start it afresh, also after it failed.",
			Category:    "Plugin",
			Args:        []ArgSpec{nameArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Restart(ctx, connect.NewRequest(&v1.RestartPluginRequest{Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: "restarted " + a.String("name") + " (" + pluginState(res.Msg.GetPlugin().GetState()) + ")", JSON: res.Msg}, nil
			},
		},
		Command{
			Name:         "plugin.reload",
			Title:        "Reload Plugins",
			Description:  "Rescan ~/.code-foundry/plugins for added, changed and removed plugins.",
			Category:     "Plugin",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if _, err := b.Reload(ctx, connect.NewRequest(&v1.ReloadPluginsRequest{})); err != nil {
					return Result{}, err
				}
				return Result{Message: "rescanned the plugins directory"}, nil
			},
		},
		Command{
			Name:  "plugin.logs",
			Title: "Show Plugin Log",
			Description: "Print the end of a plugin's log: its stderr, its log messages and the daemon's lines about it " +
				"(starts, exits, refused calls), and the log file's path. --follow keeps printing (CLI).",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         []ArgSpec{nameArg, withDefault(ArgSpec{Name: "lines", Type: Int, Description: "How many lines"}, "50"), followArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Logs(ctx, connect.NewRequest(&v1.PluginLogsRequest{Name: a.String("name"), Lines: int32(a.Int("lines"))}))
				if err != nil {
					return Result{}, err
				}
				if a.Bool("follow") {
					// The CLI streams the tail itself (PluginService.FollowLogs).
					return Result{JSON: res.Msg}, nil
				}
				return Result{Message: formatPluginLog(res.Msg), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.dev",
			Title: "Develop Plugin",
			Description: "Link a plugin folder (with its plugin.json) into ~/.code-foundry/plugins under the manifest's name " +
				"and enable it, asking for consent like plugin enable. A dev plugin restarts within 2 s after a crash and " +
				"never gives up. From a terminal the CLI then follows its log (--follow=false: do not).",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "path", Type: Path, Required: true, Positional: true, Description: "The plugin's folder"},
				followArg,
			},
			Confirm: "Link {path} as a dev plugin and enable it?",
			ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
				res, err := b.Dev(ctx, connect.NewRequest(&v1.DevPluginRequest{Path: a.Path("path"), DryRun: true}))
				return err == nil && res.Msg.GetNeedsConsent()
			},
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
				res, err := b.Dev(ctx, connect.NewRequest(&v1.DevPluginRequest{Path: a.Path("path"), DryRun: true}))
				if err != nil {
					return ""
				}
				return res.Msg.GetConsentText()
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Dev(ctx, connect.NewRequest(&v1.DevPluginRequest{Path: a.Path("path"), Consent: true}))
				if err != nil {
					return Result{}, err
				}
				p := res.Msg.GetPlugin()
				return Result{Message: fmt.Sprintf("linked %s as dev plugin %s; %s", a.Path("path"), p.GetName(), enabledMessage(p)), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:         "plugin.secrets.list",
			Title:        "List Plugin Secrets",
			Description:  "List the names of the secrets a plugin keeps in the Keychain (service code-foundry-plugin), never their values.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         []ArgSpec{nameArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.ListSecrets(ctx, connect.NewRequest(&v1.ListPluginSecretsRequest{Name: a.String("name")}))
				if err != nil {
					return Result{}, err
				}
				if len(res.Msg.GetSecrets()) == 0 {
					return Result{Message: "plugin " + a.String("name") + " has no secrets", JSON: res.Msg}, nil
				}
				var sb strings.Builder
				tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
				_, _ = fmt.Fprintln(tw, "KEY\tSET")
				for _, s := range res.Msg.GetSecrets() {
					_, _ = fmt.Fprintf(tw, "%s\t%s\n", s.GetKey(), s.GetUpdatedAt().AsTime().Local().Format("2006-01-02 15:04"))
				}
				_ = tw.Flush()
				return Result{Message: strings.TrimRight(sb.String(), "\n"), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:        "plugin.secrets.delete",
			Title:       "Delete Plugin Secret",
			Description: "Delete one of a plugin's secrets from the Keychain.",
			Category:    "Plugin",
			Args:        []ArgSpec{nameArg, {Name: "key", Type: String, Required: true, Positional: true, Description: "Secret name (plugin secrets list)"}},
			Confirm:     "Delete secret {key} of plugin {name} from the Keychain?",
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				if _, err := b.DeleteSecret(ctx, connect.NewRequest(&v1.DeletePluginSecretRequest{Name: a.String("name"), Key: a.String("key")})); err != nil {
					return Result{}, err
				}
				return Result{Message: "deleted secret " + a.String("key") + " of plugin " + a.String("name")}, nil
			},
		},
	)
}

// pluginState is a state in words.
func pluginState(s v1.PluginState) string {
	return strings.ToLower(strings.TrimPrefix(s.String(), "PLUGIN_STATE_"))
}

func enabledMessage(p *v1.Plugin) string {
	msg := fmt.Sprintf("enabled %s %s (%s)", p.GetName(), p.GetVersion(), pluginState(p.GetState()))
	if n := len(p.GetCommands()); n > 0 {
		names := make([]string, n)
		for i, c := range p.GetCommands() {
			names[i] = strings.ReplaceAll(c.GetName(), ".", " ")
		}
		msg += "\ncommands: code-foundry " + strings.Join(names, ", code-foundry ")
	}
	return msg
}

// permissionSummary is a short list of what a plugin asks for.
func permissionSummary(p *v1.PluginPermissions) string {
	var out []string
	if len(p.GetCommands()) > 0 {
		out = append(out, "commands("+strings.Join(p.GetCommands(), ",")+")")
	}
	if len(p.GetEvents()) > 0 {
		out = append(out, "events("+strings.Join(p.GetEvents(), ",")+")")
	}
	for _, f := range []struct {
		on   bool
		name string
	}{{p.GetThreadStatus(), "threadStatus"}, {p.GetSessionEnv(), "sessionEnv"}, {p.GetSecrets(), "secrets"},
		{p.GetThreads(), "threads"}, {p.GetTerminals(), "terminals"}, {p.GetApi(), "api"}} {
		if f.on {
			out = append(out, f.name)
		}
	}
	if len(out) == 0 {
		return "-"
	}
	return strings.Join(out, " ")
}

func formatPlugins(ps []*v1.Plugin) string {
	if len(ps) == 0 {
		return "no plugins (put one in ~/.code-foundry/plugins/<name>, or: code-foundry plugin dev <folder>)"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "NAME\tVERSION\tSTATE\tPERMISSIONS\tCOMMANDS\tNOTE")
	for _, p := range ps {
		state := pluginState(p.GetState())
		if p.GetDev() {
			state += " (dev)"
		}
		note := ""
		if p.GetState() == v1.PluginState_PLUGIN_STATE_CRASHED || p.GetState() == v1.PluginState_PLUGIN_STATE_FAILED {
			note = p.GetLastError()
		}
		switch {
		case p.GetDisabledReason() != "":
			note = p.GetDisabledReason()
		case !p.GetEnabled() && p.GetNeedsConsent() && note == "":
			note = "new: code-foundry plugin enable " + p.GetName()
		case p.GetState() == v1.PluginState_PLUGIN_STATE_CRASHED && p.GetNextRestartAt() != nil:
			note = fmt.Sprintf("%s (restart %d)", note, p.GetRestarts())
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%d\t%s\n", p.GetName(), p.GetVersion(), state,
			permissionSummary(p.GetPermissions()), len(p.GetCommands()), note)
	}
	_ = tw.Flush()
	return strings.TrimRight(sb.String(), "\n")
}

// FormatPluginLogLine is one log line as the CLI prints it.
func FormatPluginLogLine(l *v1.PluginLogLine) string {
	tag := l.GetSource()
	if l.GetLevel() != "" {
		tag += " " + l.GetLevel()
	}
	return fmt.Sprintf("%s %-10s %s", l.GetTime().AsTime().Local().Format("15:04:05.000"), tag, l.GetText())
}

func formatPluginLog(res *v1.PluginLogsResponse) string {
	var sb strings.Builder
	for _, l := range res.GetLines() {
		sb.WriteString(FormatPluginLogLine(l) + "\n")
	}
	if len(res.GetLines()) == 0 {
		sb.WriteString("(nothing logged yet)\n")
	}
	sb.WriteString("log file: " + res.GetPath())
	return sb.String()
}
