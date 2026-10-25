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

// PluginThreadLister is ThreadService.List: plugin.uninstall's confirm counts the
// threads it removes.
type PluginThreadLister interface {
	List(context.Context, *connect.Request[v1.ListThreadsRequest]) (*connect.Response[v1.ListThreadsResponse], error)
}

// RegisterPluginRegistry registers plugin.browse, plugin.install, plugin.update and
// plugin.uninstall. threads (may be nil) counts a plugin's threads for the uninstall
// confirm.
func RegisterPluginRegistry(r *Registry, b PluginRegistryBackend, threads PluginThreadLister) error {
	refreshArg := ArgSpec{Name: "refresh", Type: Bool, Description: "Read the registries again instead of their cached indexes (kept 1 hour)"}
	return r.RegisterAll(
		Command{
			Name:     "plugin.browse",
			ReadOnly: true,
			Title:    "Browse Plugins",
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
				"release (the tarball <name>-<version>-darwin-<arch>.tar.gz, checked against the release's checksums file: " +
				"checksums.txt, SHA256SUMS, sha256sums.txt, <name>-<version>-checksums.txt or <tarball>.sha256), " +
				"or an absolute folder, linked like plugin dev. It downloads, checks the SHA-256 and installs into " +
				"~/.code-foundry/plugins/<name>, replacing an older version (its data stays). It stays disabled until you " +
				"enable it (plugin enable lists its permissions); --enable --yes enables it at once.",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "ref", Type: String, Required: true, Positional: true, Description: "name[@version], owner/repo[@vX.Y.Z], or /absolute/folder"},
				{Name: "enable", Type: Bool, Description: "Enable it afterwards, consenting to its permissions (asks; --yes confirms)"},
				{Name: "force", Type: Bool, Description: "Replace a dev link, reinstall the version already installed, or take the name " +
					"from a plugin of another source (deleting its secrets, data and consent and removing its threads; enabling asks again)"},
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
				"--check only lists them. A plugin updates only from the source it was installed from: its registry, or for " +
				"<owner>/<repo> a registry entry of that repository, else the repository's latest release. Another source's " +
				"newer version is listed as not offered (plugin install --force switches). An enabled plugin stays enabled " +
				"unless the new version asks for more permissions (then enable it again to review them). Dev plugins are never updated.",
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
			Description: "Disable a plugin, stop it, remove its threads (as thread remove does) and its package (for a dev " +
				"plugin only the link, never your folder). Its data, secrets and consent stay for a reinstall; --purge deletes " +
				"them too.",
			Category: "Plugin",
			Args: []ArgSpec{
				{Name: "name", Type: String, Required: true, Positional: true, Description: "Plugin name (code-foundry plugin list)"},
				{Name: "purge", Type: Bool, Description: "Also delete its data directory, its secrets in the Keychain, its logs and the consent given"},
			},
			Confirm: "Uninstall plugin {name}?",
			DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
				return uninstallConfirm(a.String("name"), a.Bool("purge"), pluginThreadCount(ctx, threads, a.String("name")))
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
				if ids := res.Msg.GetRemovedThreadIds(); len(ids) > 0 {
					msg += "\nremoved " + threadsWords(len(ids)) + ": " + strings.Join(ids, ", ")
				}
				if p := res.Msg.GetPurged(); len(p) > 0 {
					msg += "\ndeleted " + strings.Join(p, ", ")
				}
				return Result{Message: msg, JSON: res.Msg}, nil
			},
		},
	)
}

// uninstallConfirm is plugin.uninstall's confirm text; n is how many threads the plugin
// has (they are removed), 0 when it has none or that is unknown.
func uninstallConfirm(name string, purge bool, n int) string {
	switch {
	case purge && n > 0:
		return "Uninstall plugin " + name + "? It removes " + threadsWords(n) + " and deletes its data, its secrets in the Keychain, its logs and the consent given."
	case purge:
		return "Uninstall plugin " + name + " and delete its data, its secrets in the Keychain, its logs and the consent given?"
	case n > 0:
		return "Uninstall plugin " + name + "? It removes " + threadsWords(n) + "; its data, secrets and consent stay (--purge deletes them)."
	}
	return "Uninstall plugin " + name + "? Its data, secrets and consent stay (--purge deletes them)."
}

// pluginThreadCount counts plugin name's threads, archived ones too; 0 when that cannot
// be asked.
func pluginThreadCount(ctx context.Context, threads PluginThreadLister, name string) int {
	if threads == nil {
		return 0
	}
	res, err := threads.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{Owner: pluginOwner(name), IncludeArchived: true}}))
	if err != nil {
		return 0
	}
	return len(res.Msg.GetThreads())
}

// threadsWords is "its N thread(s)".
func threadsWords(n int) string {
	if n == 1 {
		return "its 1 thread"
	}
	return fmt.Sprintf("its %d threads", n)
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

// relationNote is what plugin.browse's INSTALLED column adds to the installed version:
// the daemon's relation (PluginIndexEntry.relation), as Browse in the GUI shows it.
func relationNote(e *v1.PluginIndexEntry) string {
	switch e.GetRelation() {
	case v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_DEV:
		return " (dev)"
	case v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_UPDATE:
		return " (update)"
	case v1.PluginIndexRelation_PLUGIN_INDEX_RELATION_OTHER_SOURCE:
		return " (installed from " + e.GetInstalledFrom() + ")"
	}
	return ""
}

// notOffered is the line for an update a registry lists of a plugin installed from
// another source (PluginUpdate.installed_from): no offer, and how to switch.
func notOffered(u *v1.PluginUpdate) string {
	return fmt.Sprintf("not offered: %s %s from %s (installed from %s; `code-foundry plugin install %s --force` switches to it, deleting its secrets, data and consent)",
		u.GetName(), u.GetVersion(), u.GetRegistry(), u.GetInstalledFrom(), u.GetName())
}

func formatUpdates(ups []*v1.PluginUpdate, check bool) string {
	var offers, others []*v1.PluginUpdate
	for _, u := range ups {
		if u.GetInstalledFrom() != "" {
			others = append(others, u)
		} else {
			offers = append(offers, u)
		}
	}
	var lines []string
	switch {
	case len(offers) == 0:
		lines = append(lines, "every plugin is up to date")
	case check:
		var sb strings.Builder
		tw := tabwriter.NewWriter(&sb, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(tw, "NAME\tINSTALLED\tAVAILABLE\tREGISTRY")
		for _, u := range offers {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", u.GetName(), u.GetCurrentVersion(), u.GetVersion(), u.GetRegistry())
		}
		_ = tw.Flush()
		sb.WriteString("install with: code-foundry plugin update [<name>]")
		lines = append(lines, sb.String())
	default:
		lines = append(lines, updatedLines(offers)...)
	}
	for _, u := range others {
		lines = append(lines, notOffered(u))
	}
	return strings.Join(lines, "\n")
}

func updatedLines(ups []*v1.PluginUpdate) []string {
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
	return lines
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
				inst = p.GetVersion() + relationNote(e)
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
