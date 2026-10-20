package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
)

// SkillStore is the skill store (*skill.Store) as SkillService and the EventService
// skill source read it. The lifecycle is the skill.* commands', not this service's.
type SkillStore interface {
	Snapshot() *skill.Snapshot
	Search(q marketplace.Query) marketplace.Result
	Refresh(ctx context.Context) error
}

var _ SkillStore = (*skill.Store)(nil)

// Skill implements codefoundryv1connect.SkillServiceHandler over the skill store
// (docs/notes/skills-3-api.md).
type Skill struct {
	store SkillStore
	bus   *bus.Bus
}

var _ codefoundryv1connect.SkillServiceHandler = (*Skill)(nil)

// NewSkill returns a SkillService handler. b must be the bus the store publishes
// skill.Event on.
func NewSkill(store SkillStore, b *bus.Bus) *Skill { return &Skill{store: store, bus: b} }

// Route mounts the service.
func (h *Skill) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewSkillServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Search searches the marketplaces' entries, each with what is installed of it.
func (h *Skill) Search(ctx context.Context, req *connect.Request[v1.SearchSkillsRequest]) (*connect.Response[v1.SearchSkillsResponse], error) {
	m := req.Msg
	out := &v1.SearchSkillsResponse{}
	if m.GetRefresh() {
		if err := h.store.Refresh(ctx); err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			out.RefreshError = err.Error()
		}
	}
	snap := h.store.Snapshot()
	res := h.store.Search(marketplace.Query{
		Text: m.GetQuery(), Tier: skillTiers.from(m.GetTier()), Kind: skillKinds.from(m.GetKind()), Limit: int(m.GetLimit()),
	})
	out.Total, out.Epoch = int32(res.Total), snap.Epoch
	for _, e := range res.Entries {
		out.Entries = append(out.Entries, skillEntryToProto(snap, e))
	}
	return connect.NewResponse(out), nil
}

// Installed lists what is installed.
func (h *Skill) Installed(context.Context, *connect.Request[v1.ListInstalledSkillsRequest]) (*connect.Response[v1.ListInstalledSkillsResponse], error) {
	snap := h.store.Snapshot()
	out := &v1.ListInstalledSkillsResponse{PluginsError: snap.PluginsErr, Epoch: snap.Epoch}
	for _, in := range snap.Installed {
		out.Installed = append(out.Installed, installedSkillToProto(in))
	}
	return connect.NewResponse(out), nil
}

// Registries lists the marketplaces.
func (h *Skill) Registries(context.Context, *connect.Request[v1.ListSkillRegistriesRequest]) (*connect.Response[v1.ListSkillRegistriesResponse], error) {
	snap := h.store.Snapshot()
	out := &v1.ListSkillRegistriesResponse{Error: snap.Err, ExpectedMarketplace: skill.ExpectedMarketplace, Epoch: snap.Epoch}
	for _, r := range snap.Registries {
		out.Registries = append(out.Registries, &v1.SkillRegistry{
			Name: r.Name, Repo: r.Repo, Source: r.Source, Url: r.URL, Ref: r.Ref, Dir: r.Dir, Owner: r.Owner,
			Plugins: int32(r.Plugins), Skills: int32(r.Skills), Shallow: r.Shallow,
			ReadAt: optionalTime(r.ReadAt), RefreshedAt: optionalTime(r.RefreshedAt), Error: r.Err, Issues: r.Issues,
		})
	}
	return connect.NewResponse(out), nil
}

// Watch sends the current epoch, then each new one.
func (h *Skill) Watch(ctx context.Context, _ *connect.Request[v1.WatchSkillsRequest], stream *connect.ServerStream[v1.SkillEvent]) error {
	sub := bus.Subscribe[skill.Event](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(&v1.SkillEvent{Epoch: h.store.Snapshot().Epoch}); err != nil {
		return err
	}
	var dropped uint64
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if d := sub.Dropped(); d != dropped {
				dropped = d
				ev = h.store.Snapshot()
			}
			if msg := skillEventToProto(ev); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// skillEventToProto converts a bus event (or a *skill.Snapshot) to the wire event.
func skillEventToProto(ev skill.Event) *v1.SkillEvent {
	switch e := ev.(type) {
	case skill.Changed:
		return &v1.SkillEvent{Epoch: e.Epoch}
	case *skill.Snapshot:
		return &v1.SkillEvent{Epoch: e.Epoch}
	}
	return nil
}

// enumMap maps a store string enum to its wire enum and back; "" is UNSPECIFIED.
type enumMap[S ~string, P comparable] map[S]P

func (m enumMap[S, P]) to(s S) P { return m[s] }

func (m enumMap[S, P]) from(p P) S {
	for s, v := range m {
		if v == p {
			return s
		}
	}
	return ""
}

var (
	skillKinds = enumMap[marketplace.Kind, v1.SkillKind]{
		marketplace.KindPlugin: v1.SkillKind_SKILL_KIND_PLUGIN,
		marketplace.KindSkill:  v1.SkillKind_SKILL_KIND_SKILL,
	}
	skillTiers = enumMap[marketplace.Tier, v1.SkillTier]{
		marketplace.TierEnterprise: v1.SkillTier_SKILL_TIER_ENTERPRISE,
		marketplace.TierCommunity:  v1.SkillTier_SKILL_TIER_COMMUNITY,
	}
)

func skillEntryToProto(snap *skill.Snapshot, e marketplace.Entry) *v1.SkillEntry {
	out := &v1.SkillEntry{
		Kind: skillKinds.to(e.Kind), Tier: skillTiers.to(e.Tier), Name: e.Name, Description: e.Description, By: e.By,
		Version: e.Version, DeclaredVersion: e.DeclaredVersion, LastUpdated: optionalTime(e.LastUpdated),
		Registry: e.Registry, Path: e.Path, Keywords: e.Keywords, Skills: e.Skills, SetupScript: e.SetupScript,
		State: v1.SkillEntryState_SKILL_ENTRY_STATE_NOT_INSTALLED,
	}
	if in, ok := snap.InstalledOf(e); ok {
		out.State, out.InstalledVersion = v1.SkillEntryState_SKILL_ENTRY_STATE_DISABLED, in.Version
		if in.Enabled {
			out.State = v1.SkillEntryState_SKILL_ENTRY_STATE_ENABLED
		}
		if in.Update != nil {
			out.UpdateVersion = in.Update.Version
		}
	}
	return out
}

func installedSkillToProto(in skill.Installed) *v1.InstalledSkill {
	out := &v1.InstalledSkill{
		Kind: skillKinds.to(in.Kind), Name: in.Name, Id: in.ID(), Registry: in.Registry, Path: in.Path,
		Tier: skillTiers.to(in.Tier), Description: in.Description, By: in.By, Version: in.Version,
		LastUpdated: optionalTime(in.LastUpdated), Enabled: in.Enabled, Dir: in.Dir, Scope: in.Scope,
		Skills: in.Skills, SetupScript: in.SetupScript, NeedsSetup: in.NeedsSetup,
		State: v1.InstalledSkillState_INSTALLED_SKILL_STATE_INSTALLED,
	}
	switch {
	case in.Local:
		out.State = v1.InstalledSkillState_INSTALLED_SKILL_STATE_LOCAL
	case in.Missing:
		out.State = v1.InstalledSkillState_INSTALLED_SKILL_STATE_MISSING
	}
	if u := in.Update; u != nil {
		out.Update = &v1.SkillOffer{Version: u.Version, LastUpdated: optionalTime(u.LastUpdated), CommitSha: u.CommitSHA}
	}
	return out
}

// skillSource is EventService's skill source: the epoch, on connect and per read.
type skillSource struct {
	store SkillStore
	bus   *bus.Bus
}

func (skillSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_SKILL }

func skillWrap(ev skill.Event) *v1.Event {
	if m := skillEventToProto(ev); m != nil {
		return &v1.Event{Event: &v1.Event_Skill{Skill: m}}
	}
	return nil
}

func (s skillSource) topics() []topic {
	return []topic{busTopic(s.bus, watchBuffer, skillWrap)}
}

func (s skillSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{skillWrap(s.store.Snapshot())}
}
