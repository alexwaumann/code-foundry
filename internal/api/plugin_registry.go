package api

import (
	"context"
	"errors"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/plugin/registry"
)

// PluginService's registry half (docs/notes/plugins-7-registry.md): Browse,
// RefreshRegistries, Install, Update, Uninstall. The store implements plugin.Installer;
// one that does not answers Unimplemented.

func (h *Plugin) installer() (plugin.Installer, error) {
	if inst, ok := h.store.(plugin.Installer); ok {
		return inst, nil
	}
	return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this plugin store cannot install plugins"))
}

// Browse lists the registries' plugins with what is installed of each.
func (h *Plugin) Browse(ctx context.Context, req *connect.Request[v1.BrowsePluginsRequest]) (*connect.Response[v1.BrowsePluginsResponse], error) {
	inst, err := h.installer()
	if err != nil {
		return nil, err
	}
	res, err := inst.Browse(ctx, req.Msg.GetRefresh())
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.BrowsePluginsResponse{Platform: registry.Platform(), Registries: registriesToProto(res.Registries)}
	for _, e := range res.Entries {
		out.Entries = append(out.Entries, indexEntryToProto(e))
	}
	return connect.NewResponse(out), nil
}

// RefreshRegistries reads every registry again.
func (h *Plugin) RefreshRegistries(ctx context.Context, _ *connect.Request[v1.RefreshPluginRegistriesRequest]) (*connect.Response[v1.RefreshPluginRegistriesResponse], error) {
	inst, err := h.installer()
	if err != nil {
		return nil, err
	}
	res, err := inst.Browse(ctx, true)
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.RefreshPluginRegistriesResponse{Registries: registriesToProto(res.Registries)}), nil
}

// Install installs a plugin.
func (h *Plugin) Install(ctx context.Context, req *connect.Request[v1.InstallPluginRequest]) (*connect.Response[v1.InstallPluginResponse], error) {
	inst, err := h.installer()
	if err != nil {
		return nil, err
	}
	m := req.Msg
	res, err := inst.Install(ctx, plugin.InstallRequest{
		Ref: m.GetRef(), Force: m.GetForce(), Enable: m.GetEnable(), Consent: m.GetConsent(), Refresh: m.GetRefresh(),
	})
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.InstallPluginResponse{
		Plugin: pluginToProto(res.Plugin), Kind: string(res.Kind), Source: res.Source, Version: res.Version,
		PreviousVersion: res.Previous, Changed: res.Changed, Warnings: res.Warnings,
		NeedsConsent: res.NeedsConsent, ConsentText: res.Consent, RemovedThreadIds: res.RemovedThreads,
	}), nil
}

// Update installs (or with check lists) the registries' newer versions.
func (h *Plugin) Update(ctx context.Context, req *connect.Request[v1.UpdatePluginsRequest]) (*connect.Response[v1.UpdatePluginsResponse], error) {
	inst, err := h.installer()
	if err != nil {
		return nil, err
	}
	m := req.Msg
	ups, err := inst.Update(ctx, m.GetName(), m.GetCheck(), m.GetRefresh())
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.UpdatePluginsResponse{}
	for _, u := range ups {
		out.Updates = append(out.Updates, &v1.PluginUpdate{
			Name: u.Name, CurrentVersion: u.Current, Version: u.Version, Registry: u.Registry,
			Updated: u.Updated, Error: u.Error, DisabledReason: u.Disabled,
		})
	}
	return connect.NewResponse(out), nil
}

// Uninstall removes a plugin.
func (h *Plugin) Uninstall(ctx context.Context, req *connect.Request[v1.UninstallPluginRequest]) (*connect.Response[v1.UninstallPluginResponse], error) {
	inst, err := h.installer()
	if err != nil {
		return nil, err
	}
	res, err := inst.Uninstall(ctx, req.Msg.GetName(), req.Msg.GetPurge())
	if err != nil {
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.UninstallPluginResponse{Removed: res.Removed, Purged: res.Purged, RemovedThreadIds: res.RemovedThreads}), nil
}

func registriesToProto(rs []registry.Status) []*v1.PluginRegistry {
	out := make([]*v1.PluginRegistry, len(rs))
	for i, r := range rs {
		out[i] = &v1.PluginRegistry{
			Url: r.URL, FetchedAt: optionalTime(r.FetchedAt), Cached: r.Cached, Error: r.Error,
			Plugins: int32(r.Plugins), Issues: r.Issues,
		}
	}
	return out
}

func indexEntryToProto(e plugin.BrowseEntry) *v1.PluginIndexEntry {
	out := &v1.PluginIndexEntry{
		Name: e.Name, DisplayName: e.DisplayNameOr(), Description: e.Description, Repo: e.Repo, Version: e.Version,
		Protocol: int32(e.Protocol), Permissions: permissionsToProto(e.Permissions),
		PermissionLines: e.Permissions.Normalize().Describe(), Registry: e.Registry,
	}
	plats := make([]string, 0, len(e.Artifacts))
	for p := range e.Artifacts {
		plats = append(plats, p)
	}
	slices.Sort(plats)
	for _, p := range plats {
		a := e.Artifacts[p]
		out.Artifacts = append(out.Artifacts, &v1.PluginIndexArtifact{Platform: p, Url: a.URL, Sha256: a.SHA256})
	}
	_, out.Available = e.Artifact(registry.Platform())
	if e.Installed != nil {
		out.Installed = pluginToProto(*e.Installed)
		out.UpdateAvailable = !e.Installed.Dev && registry.Newer(e.Version, e.Installed.Manifest.Version)
	}
	return out
}

// fillInstall sets a plugin's install record and update offer (pluginToProto).
func fillInstall(out *v1.Plugin, p plugin.Plugin) {
	if r := p.Installed; r != nil {
		out.Install = &v1.PluginInstall{
			Kind: string(r.Kind), Source: r.Source, Version: r.Version, Sha256: r.SHA256, InstalledAt: optionalTime(r.InstalledAt),
		}
	}
	if u := p.Update; u != nil {
		out.UpdateAvailable, out.UpdateVersion, out.UpdateRegistry = true, u.Version, u.Registry
	}
}

var installPhases = map[plugin.InstallPhase]v1.PluginInstallPhase{
	plugin.InstallResolving:   v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_RESOLVING,
	plugin.InstallDownloading: v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_DOWNLOADING,
	plugin.InstallVerifying:   v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_VERIFYING,
	plugin.InstallExtracting:  v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_EXTRACTING,
	plugin.InstallSwapping:    v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_INSTALLING,
	plugin.InstallDone:        v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_DONE,
	plugin.InstallFailed:      v1.PluginInstallPhase_PLUGIN_INSTALL_PHASE_FAILED,
}

// registryEventToProto converts the registry half's bus events (pluginEventToProto).
func registryEventToProto(ev plugin.Event) *v1.PluginEvent {
	switch e := ev.(type) {
	case plugin.InstallProgress:
		return &v1.PluginEvent{Event: &v1.PluginEvent_InstallProgress{InstallProgress: &v1.PluginInstallProgress{
			Ref: e.Ref, Name: e.Name, Version: e.Version, Phase: installPhases[e.Phase], Message: e.Message, Bytes: e.Bytes,
		}}}
	case plugin.RegistryChanged:
		return &v1.PluginEvent{Event: &v1.PluginEvent_RegistryEpoch{RegistryEpoch: e.Epoch}}
	}
	return nil
}
