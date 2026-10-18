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

// plugin.browse, plugin.install, plugin.update and plugin.uninstall
// (docs/notes/plugins-7-registry.md): the plugin registries (the plugins.registries
// setting) and installing from them, from a GitHub release, or from a folder.

// PluginRegistryBackend is the slice of PluginService the registry verbs need.
type PluginRegistryBackend interface {
	Browse(context.Context, *connect.Request[v1.BrowsePluginsRequest]) (*connect.Response[v1.BrowsePluginsResponse], error)
	Install(context.Context, *connect.Request[v1.InstallPluginRequest]) (*connect.Response[v1.InstallPluginResponse], error)
	Update(context.Context, *connect.Request[v1.UpdatePluginsRequest]) (*connect.Response[v1.UpdatePluginsResponse], error)
	Uninstall(context.Context, *connect.Request[v1.UninstallPluginRequest]) (*connect.Response[v1.UninstallPluginResponse], error)
}

var (
	_ PluginRegistryBackend = codefoundryv1connect.PluginServiceHandler(nil)
	_ PluginRegistryBackend = codefoundryv1connect.PluginServiceClient(nil)
)

// RegisterPluginRegistry registers plugin.browse, plugin.install, plugin.update and
// plugin.uninstall.
func RegisterPluginRegistry(r *Registry, b PluginRegistryBackend) error {
	refreshArg := ArgSpec{Name: "refresh", Type: Bool, Description: "Read the registries again instead of their cached indexes (kept 1 hour)"}
	return r.RegisterAll(
		Command{
			Name:  "plugin.browse",
			Title: "Browse Plugins",
			Description: "List the plugins the registries offer (settings plugins.registries; the first registry listing a " +
				"name wins): version, what is installed, the permissions each asks for, and each registry's state.",
			Category:     "Plugin",
			NoKeybinding: true,
			Args:         []ArgSpec{refreshArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Browse(ctx, connect.NewRequest(&v1.BrowsePluginsRequest{Refresh: a.Bool("refresh")}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatBrowse(res.Msg), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.install",
			Title: "Install Plugin",
			Description: "Install a plugin: <name>[@<version>] from the registries, <owner>/<repo>[@vX.Y.Z] from a GitHub " +
				"release (the tarball <name>-<version>-darwin-<arch>.tar.gz, checked against the release's checksums.txt), " +
				"or an absolute folder, linked like plugin dev. It downloads, checks the SHA-256 and installs into " +
				"~/.code-foundry/plugins/<name>, replacing an older version (its data stays). It stays disabled until you " +
				"enable it (plugin enable lists its permissions); --enable --yes enables it at once.",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "ref", Type: String, Required: true, Positional: true, Description: "name[@version], owner/repo[@vX.Y.Z], or /absolute/folder"},
				{Name: "enable", Type: Bool, Description: "Enable it afterwards, consenting to its permissions (asks; --yes confirms)"},
				{Name: "force", Type: Bool, Description: "Replace a dev link, or reinstall the version already installed"},
				refreshArg,
			},
			Confirm:   "Install {ref} and enable it?",
			ConfirmIf: func(_ context.Context, _ Context, a Args) bool { return a.Bool("enable") },
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
				return installConsent(ctx, b, a.String("ref"))
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				enable := a.Bool("enable")
				res, err := b.Install(ctx, connect.NewRequest(&v1.InstallPluginRequest{
					Ref: a.String("ref"), Force: a.Bool("force"), Enable: enable, Consent: enable, Refresh: a.Bool("refresh"),
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: installedMessage(res.Msg, enable), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.update",
			Title: "Update Plugins",
			Description: "Install the newer versions the registries list, of one plugin or of every installed plugin; " +
				"--check only lists them. An enabled plugin stays enabled unless the new version asks for more " +
				"permissions (then enable it again to review them). Dev plugins are never updated.",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "name", Type: String, Positional: true, Description: "Plugin name (default: every plugin with an update)"},
				{Name: "check", Type: Bool, Description: "Only list the updates"},
				refreshArg,
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Update(ctx, connect.NewRequest(&v1.UpdatePluginsRequest{
					Name: a.String("name"), Check: a.Bool("check"), Refresh: a.Bool("refresh"),
				}))
				if err != nil {
					return Result{}, err
				}
				return Result{Message: formatUpdates(res.Msg.GetUpdates(), a.Bool("check")), JSON: res.Msg}, nil
			},
		},
		Command{
			Name:  "plugin.uninstall",
			Title: "Uninstall Plugin",
			Description: "Disable a plugin, stop it and remove its package (for a dev plugin only the link, never your " +
				"folder). Its data, secrets and consent stay for a reinstall; --purge deletes them too.",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "Plugin name (code-foundry plugin list)"},
				{Name: "purge", Type: Bool, Description: "Also delete its data directory, its secrets in the Keychain, its logs and the consent given"},
			},
			Confirm: "Uninstall plugin {name}?",
			DynamicConfirm: func(_ context.Context, _ Context, a Args) string {
				if a.Bool("purge") {
					return "Uninstall plugin " + a.String("name") + " and delete its data, its secrets in the Keychain, its logs and the consent given?"
				}
				return "Uninstall plugin " + a.String("name") + "? Its data, secrets and consent stay (--purge deletes them)."
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				res, err := b.Uninstall(ctx, connect.NewRequest(&v1.UninstallPluginRequest{Name: a.String("name"), Purge: a.Bool("purge")}))
				if err != nil {
					return Result{}, err
				}
				msg := "uninstalled " + a.String("name")
				if res.Msg.GetRemoved() != "" {
					msg += " (removed " + res.Msg.GetRemoved() + ")"
				}
				if p := res.Msg.GetPurged(); len(p) > 0 {
					msg += "\ndeleted " + strings.Join(p, ", ")
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
	)
}

// installConsent is the confirm text of plugin.install --enable: for a registry name, the
// entry's permissions (the package may not ask for more); otherwise they are only known
// after the download.
func installConsent(ctx context.Context, b PluginRegistryBackend, ref string) string {
	name, _, _ := strings.Cut(ref, "@")
	if !strings.ContainsAny(ref, "/~") {
		res, err := b.Browse(ctx, connect.NewRequest(&v1.BrowsePluginsRequest{}))
		if err == nil {
			for _, e := range res.Msg.GetEntries() {
				if e.GetName() != name {
					continue
				}
				var sb strings.Builder
				fmt.Fprintf(&sb, "Install and enable %s %s from %s? It runs as you", e.GetDisplayName(), e.GetVersion(), e.GetRegistry())
				if len(e.GetPermissionLines()) == 0 {
					sb.WriteString(" and asks for no permissions.")
					return sb.String()
				}
				sb.WriteString(" and may:")
				for _, l := range e.GetPermissionLines() {
					sb.WriteString("\n  - " + l)
				}
				return sb.String()
			}
		}
	}
	return "Install " + ref + " and enable it? Its permissions are only known after the download: install it without " +
		"--enable to review them (plugin enable lists them)."
}

func installedMessage(r *v1.InstallPluginResponse, enable bool) string {
	p := r.GetPlugin()
	var lines []string
	switch {
	case !r.GetChanged():
		lines = append(lines, fmt.Sprintf("%s %s is installed already (--force reinstalls it)", p.GetName(), r.GetVersion()))
	case r.GetKind() == "path":
		lines = append(lines, fmt.Sprintf("linked %s as dev plugin %s %s", r.GetSource(), p.GetName(), r.GetVersion()))
	case r.GetPreviousVersion() != "":
		lines = append(lines, fmt.Sprintf("updated %s %s → %s from %s", p.GetName(), r.GetPreviousVersion(), r.GetVersion(), r.GetSource()))
	default:
		lines = append(lines, fmt.Sprintf("installed %s %s from %s", p.GetName(), r.GetVersion(), r.GetSource()))
	}
	for _, w := range r.GetWarnings() {
		lines = append(lines, "warning: "+w)
	}
	switch {
	case enable && r.GetNeedsConsent():
		lines = append(lines, "not enabled: it needs your consent\n"+r.GetConsentText())
	case enable || p.GetEnabled():
		lines = append(lines, enabledMessage(p))
	case p.GetDisabledReason() != "":
		lines = append(lines, "disabled: "+p.GetDisabledReason())
	default:
		lines = append(lines, "disabled until you enable it: code-foundry plugin enable "+p.GetName()+" (lists its permissions)")
	}
	return strings.Join(lines, "\n")
}

func formatUpdates(ups []*v1.PluginUpdate, check bool) string {
	if len(ups) == 0 {
		return "every plugin is up to date"
	}
	var sb strings.Builder
	if check {
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(tw, "NAME\tINSTALLED\tAVAILABLE\tREGISTRY")
		for _, u := range ups {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", u.GetName(), u.GetCurrentVersion(), u.GetVersion(), u.GetRegistry())
		}
		_ = tw.Flush()
		sb.WriteString("install with: code-foundry plugin update [<name>]")
		return sb.String()
	}
	var lines []string
	for _, u := range ups {
		switch {
		case u.GetError() != "":
			lines = append(lines, fmt.Sprintf("%s: update to %s failed: %s", u.GetName(), u.GetVersion(), u.GetError()))
		case !u.GetUpdated():
			lines = append(lines, fmt.Sprintf("%s %s is installed already", u.GetName(), u.GetVersion()))
		default:
			l := fmt.Sprintf("updated %s %s → %s", u.GetName(), u.GetCurrentVersion(), u.GetVersion())
			if u.GetDisabledReason() != "" {
				l += "; disabled: " + u.GetDisabledReason() + " (code-foundry plugin enable " + u.GetName() + ")"
			}
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "\n")
}

// noRegistryMessage is plugin.browse's answer when plugins.registries lists none (its
// default): nothing to browse, and how to add one.
const noRegistryMessage = "no plugin registry is configured; add one with: code-foundry settings set plugins.registries https://github.com/<owner>/<repo>"

func formatBrowse(r *v1.BrowsePluginsResponse) string {
	if len(r.GetRegistries()) == 0 && len(r.GetEntries()) == 0 {
		return noRegistryMessage
	}
	var sb strings.Builder
	if len(r.GetEntries()) == 0 {
		sb.WriteString("no plugins in the registries\n")
	} else {
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(tw, "NAME\tVERSION\tINSTALLED\tPERMISSIONS\tDESCRIPTION")
		for _, e := range r.GetEntries() {
			inst := "-"
			if p := e.GetInstalled(); p != nil {
				inst = p.GetVersion()
				if p.GetDev() {
					inst += " (dev)"
				} else if e.GetUpdateAvailable() {
					inst += " (update)"
				}
			}
			version := e.GetVersion()
			if !e.GetAvailable() {
				version += " (no " + r.GetPlatform() + " build)"
			}
			desc := e.GetDescription()
			if len(desc) > 60 {
				desc = desc[:57] + "..."
			}
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", e.GetName(), version, inst, permissionSummary(e.GetPermissions()), desc)
		}
		_ = tw.Flush()
		// An empty description leaves the row padded.
		lines := strings.Split(sb.String(), "\n")
		for i, l := range lines {
			lines[i] = strings.TrimRight(l, " ")
		}
		sb.Reset()
		sb.WriteString(strings.Join(lines, "\n"))
	}
	for _, reg := range r.GetRegistries() {
		line := fmt.Sprintf("registry %s: %d plugin(s)", reg.GetUrl(), reg.GetPlugins())
		if at := reg.GetFetchedAt(); at != nil {
			line += ", fetched " + at.AsTime().Local().Format("2006-01-02 15:04")
			if reg.GetCached() {
				line += " (cached)"
			}
		}
		if reg.GetError() != "" {
			line += "\n  error: " + reg.GetError()
		}
		for _, is := range reg.GetIssues() {
			line += "\n  issue: " + is
		}
		sb.WriteString(line + "\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}
