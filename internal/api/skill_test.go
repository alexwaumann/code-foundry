package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
	"github.com/alexwaumann/code-foundry/internal/store/skill/skilltest"
)

// newSkillServer serves SkillService over a real skill store reading the fixture
// marketplace through the fake claude, with enterprise-data 1.3.0 installed (its
// checkout's plugin.json says 1.3.9: an update), pr-review installed (it has a setup
// script), sql-helper installed and disabled, and a local skill "mine".
func newSkillServer(t *testing.T) (*skill.Store, *skilltest.Claude, codefoundryv1connect.SkillServiceClient) {
	t.Helper()
	ctx := context.Background()
	b := bus.New()
	claude := skilltest.New()
	installPath := t.TempDir()
	writeFile(t, filepath.Join(installPath, ".claude-plugin", "plugin.json"), `{"name":"enterprise-data","version":"1.3.0"}`)
	claude.Set([]skilltest.Marketplace{{Name: "ai-marketplace", Source: "github", Repo: "acme/ai-marketplace", InstallLocation: marketplacetest.Checkout(t)}},
		[]skilltest.Plugin{{ID: "enterprise-data@ai-marketplace", Version: "1.3.0", Scope: "user", Enabled: true, InstallPath: installPath, LastUpdated: "2026-10-01T10:00:00Z"}})
	skillsDir := filepath.Join(t.TempDir(), "skills")
	writeFile(t, filepath.Join(skillsDir, "mine", "SKILL.md"), "---\nname: mine\ndescription: My own.\nowner: Me\n---\n")
	s, err := skill.New(skill.Options{DB: dbtest.Open(t), Claude: claude, SkillsDir: skillsDir, DisabledDir: filepath.Join(t.TempDir(), "disabled"),
		Bus: b, Log: slog.New(slog.DiscardHandler), Now: func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"pr-review", "sql-helper"} {
		if _, err := s.Install(ctx, name, marketplace.KindSkill); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Disable(ctx, "sql-helper", marketplace.KindSkill); err != nil {
		t.Fatal(err)
	}
	route := NewSkill(s, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return s, claude, codefoundryv1connect.NewSkillServiceClient(srv.Client(), srv.URL)
}

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func entryNames(es []*v1.SkillEntry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.GetName())
	}
	return out
}

func TestSkillSearch(t *testing.T) {
	s, claude, c := newSkillServer(t)
	ctx := context.Background()
	tests := []struct {
		name      string
		req       *v1.SearchSkillsRequest
		wantNames []string
		wantTotal int32
	}{
		{name: "everything by name", req: &v1.SearchSkillsRequest{}, wantTotal: 7,
			wantNames: []string{"enterprise-data", "escaper", "haiku-writer", "lint-kit", "pr-review", "remote-tool", "sql-helper"}},
		{name: "name matches first", req: &v1.SearchSkillsRequest{Query: "sql"}, wantTotal: 2, wantNames: []string{"sql-helper", "enterprise-data"}},
		{name: "every word must match", req: &v1.SearchSkillsRequest{Query: "SQL warehouse"}, wantTotal: 2, wantNames: []string{"enterprise-data", "sql-helper"}},
		{name: "by matches", req: &v1.SearchSkillsRequest{Query: "guild"}, wantTotal: 1, wantNames: []string{"pr-review"}},
		{name: "community tier", req: &v1.SearchSkillsRequest{Tier: v1.SkillTier_SKILL_TIER_COMMUNITY}, wantTotal: 2, wantNames: []string{"haiku-writer", "lint-kit"}},
		{name: "skills, limited", req: &v1.SearchSkillsRequest{Kind: v1.SkillKind_SKILL_KIND_SKILL, Limit: 1}, wantTotal: 3, wantNames: []string{"haiku-writer"}},
		{name: "enterprise plugins", req: &v1.SearchSkillsRequest{Tier: v1.SkillTier_SKILL_TIER_ENTERPRISE, Kind: v1.SkillKind_SKILL_KIND_PLUGIN}, wantTotal: 1,
			wantNames: []string{"enterprise-data"}},
		{name: "nothing", req: &v1.SearchSkillsRequest{Query: "zzz"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := c.Search(ctx, connect.NewRequest(tt.req))
			if err != nil {
				t.Fatal(err)
			}
			if got := entryNames(res.Msg.GetEntries()); !slices.Equal(got, tt.wantNames) || res.Msg.GetTotal() != tt.wantTotal {
				t.Errorf("entries = %v (%d), want %v (%d)", got, res.Msg.GetTotal(), tt.wantNames, tt.wantTotal)
			}
			if res.Msg.GetEpoch() != s.Snapshot().Epoch || res.Msg.GetRefreshError() != "" {
				t.Errorf("epoch %d, refresh error %q", res.Msg.GetEpoch(), res.Msg.GetRefreshError())
			}
		})
	}

	// Each entry carries what is installed of it.
	res, err := c.Search(ctx, connect.NewRequest(&v1.SearchSkillsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*v1.SkillEntry{}
	for _, e := range res.Msg.GetEntries() {
		byName[e.GetName()] = e
	}
	states := []struct {
		name                    string
		state                   v1.SkillEntryState
		installed, update, tier string
	}{
		{"enterprise-data", v1.SkillEntryState_SKILL_ENTRY_STATE_ENABLED, "1.3.0", "1.3.9", "enterprise"},
		{"pr-review", v1.SkillEntryState_SKILL_ENTRY_STATE_ENABLED, "20260305", "", "enterprise"},
		{"sql-helper", v1.SkillEntryState_SKILL_ENTRY_STATE_DISABLED, "20260110", "", "enterprise"},
		{"haiku-writer", v1.SkillEntryState_SKILL_ENTRY_STATE_NOT_INSTALLED, "", "", "community"},
		{"remote-tool", v1.SkillEntryState_SKILL_ENTRY_STATE_NOT_INSTALLED, "", "", ""},
	}
	for _, st := range states {
		e := byName[st.name]
		if e.GetState() != st.state || e.GetInstalledVersion() != st.installed || e.GetUpdateVersion() != st.update || skillTiers.from(e.GetTier()) != marketplace.Tier(st.tier) {
			t.Errorf("%s: state %v installed %q update %q tier %v", st.name, e.GetState(), e.GetInstalledVersion(), e.GetUpdateVersion(), e.GetTier())
		}
	}
	pr := byName["pr-review"]
	if pr.GetKind() != v1.SkillKind_SKILL_KIND_SKILL || pr.GetBy() != "Code Quality Guild" || pr.GetVersion() != "20260305" ||
		pr.GetDeclaredVersion() != "2.1.0" || !pr.GetLastUpdated().AsTime().Equal(marketplacetest.PRReview) ||
		pr.GetSetupScript() != "enterprise/skills/pr-review/install.sh" || pr.GetPath() != "enterprise/skills/pr-review" ||
		pr.GetRegistry() != "ai-marketplace" || !slices.Equal(pr.GetKeywords(), []string{"review", "pull request"}) {
		t.Errorf("pr-review = %v", pr)
	}
	if ed := byName["enterprise-data"]; ed.GetKind() != v1.SkillKind_SKILL_KIND_PLUGIN || ed.GetVersion() != "1.4.0" ||
		!slices.Equal(ed.GetSkills(), []string{"catalog", "query-warehouse"}) || ed.GetBy() != "Data Platform" {
		t.Errorf("enterprise-data = %v", ed)
	}
	if rt := byName["remote-tool"]; rt.GetLastUpdated() != nil || rt.GetPath() != "" {
		t.Errorf("remote-tool = %v", rt)
	}

	// refresh updates the marketplaces first; a failure is reported, the search still runs.
	before := claude.CallCount("plugin marketplace update")
	if res, err := c.Search(ctx, connect.NewRequest(&v1.SearchSkillsRequest{Query: "sql", Refresh: true})); err != nil || res.Msg.GetRefreshError() != "" ||
		claude.CallCount("plugin marketplace update") != before+1 {
		t.Errorf("refresh = %v, %v", res, err)
	}
	claude.Fail("plugin marketplace update", errors.New("offline"))
	if res, err := c.Search(ctx, connect.NewRequest(&v1.SearchSkillsRequest{Query: "sql", Refresh: true})); err != nil ||
		res.Msg.GetRefreshError() != "offline" || res.Msg.GetTotal() != 2 {
		t.Errorf("failed refresh = %v, %v", res, err)
	}
}

func TestSkillInstalledAndRegistries(t *testing.T) {
	s, claude, c := newSkillServer(t)
	ctx := context.Background()
	res, err := c.Installed(ctx, connect.NewRequest(&v1.ListInstalledSkillsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetEpoch() != s.Snapshot().Epoch || res.Msg.GetPluginsError() != "" {
		t.Errorf("epoch %d, plugins error %q", res.Msg.GetEpoch(), res.Msg.GetPluginsError())
	}
	type row struct {
		kind                             v1.SkillKind
		state                            v1.InstalledSkillState
		registry, version, by, update    string
		enabled, needsSetup, lastUpdated bool
	}
	got := map[string]row{}
	var ids []string
	for _, in := range res.Msg.GetInstalled() {
		ids = append(ids, in.GetId())
		got[in.GetId()] = row{kind: in.GetKind(), state: in.GetState(), registry: in.GetRegistry(), version: in.GetVersion(), by: in.GetBy(),
			update: in.GetUpdate().GetVersion(), enabled: in.GetEnabled(), needsSetup: in.GetNeedsSetup(), lastUpdated: in.GetLastUpdated() != nil}
	}
	want := map[string]row{
		"enterprise-data@ai-marketplace": {kind: v1.SkillKind_SKILL_KIND_PLUGIN, state: v1.InstalledSkillState_INSTALLED_SKILL_STATE_INSTALLED,
			registry: "ai-marketplace", version: "1.3.0", by: "Data Platform", update: "1.3.9", enabled: true, lastUpdated: true},
		"mine": {kind: v1.SkillKind_SKILL_KIND_SKILL, state: v1.InstalledSkillState_INSTALLED_SKILL_STATE_LOCAL, by: "Me", enabled: true},
		"pr-review": {kind: v1.SkillKind_SKILL_KIND_SKILL, state: v1.InstalledSkillState_INSTALLED_SKILL_STATE_INSTALLED,
			registry: "ai-marketplace", version: "20260305", by: "Code Quality Guild", enabled: true, needsSetup: true, lastUpdated: true},
		"sql-helper": {kind: v1.SkillKind_SKILL_KIND_SKILL, state: v1.InstalledSkillState_INSTALLED_SKILL_STATE_INSTALLED,
			registry: "ai-marketplace", version: "20260110", by: "Jane Doe", needsSetup: true, lastUpdated: true},
	}
	for id, w := range want {
		if got[id] != w {
			t.Errorf("%s:\n got %+v\nwant %+v", id, got[id], w)
		}
	}
	if !slices.Equal(ids, []string{"enterprise-data@ai-marketplace", "mine", "pr-review", "sql-helper"}) {
		t.Errorf("ids = %v", ids)
	}
	ed := res.Msg.GetInstalled()[0]
	if ed.GetScope() != "user" || ed.GetName() != "enterprise-data" || !slices.Equal(ed.GetSkills(), []string{"catalog", "query-warehouse"}) ||
		ed.GetTier() != v1.SkillTier_SKILL_TIER_ENTERPRISE || ed.GetUpdate().GetLastUpdated() == nil {
		t.Errorf("enterprise-data = %v", ed)
	}
	if pr := res.Msg.GetInstalled()[2]; pr.GetSetupScript() != "install.sh" || pr.GetPath() != "enterprise/skills/pr-review" || pr.GetDir() == "" {
		t.Errorf("pr-review = %v", pr)
	}

	regs, err := c.Registries(ctx, connect.NewRequest(&v1.ListSkillRegistriesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if regs.Msg.GetExpectedMarketplace() != "ai-marketplace" || regs.Msg.GetError() != "" || regs.Msg.GetEpoch() != s.Snapshot().Epoch || len(regs.Msg.GetRegistries()) != 1 {
		t.Fatalf("registries = %v", regs.Msg)
	}
	r := regs.Msg.GetRegistries()[0]
	if r.GetName() != "ai-marketplace" || r.GetRepo() != "acme/ai-marketplace" || r.GetSource() != "github" || r.GetOwner() != "AI Platform" ||
		r.GetPlugins() != 4 || r.GetSkills() != 3 || r.GetShallow() || r.GetReadAt() == nil || r.GetRefreshedAt() != nil || r.GetDir() == "" ||
		len(r.GetIssues()) == 0 {
		t.Errorf("registry = %v", r)
	}

	// Claude Code without marketplaces: the empty list still names the one to add; a
	// failed list keeps the last good registries with the error.
	claude.Fail("plugin marketplace list", errors.New("claude: not found"))
	_ = s.Load(ctx)
	regs, _ = c.Registries(ctx, connect.NewRequest(&v1.ListSkillRegistriesRequest{}))
	if regs.Msg.GetError() != "claude: not found" || len(regs.Msg.GetRegistries()) != 1 {
		t.Errorf("failed list = %v", regs.Msg)
	}
	claude.Fail("plugin marketplace list", nil)
	claude.Set(nil, nil)
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	regs, _ = c.Registries(ctx, connect.NewRequest(&v1.ListSkillRegistriesRequest{}))
	if len(regs.Msg.GetRegistries()) != 0 || regs.Msg.GetExpectedMarketplace() != "ai-marketplace" || regs.Msg.GetError() != "" {
		t.Errorf("no marketplaces = %v", regs.Msg)
	}
}

func TestSkillWatch(t *testing.T) {
	s, _, c := newSkillServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchSkillsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() uint64 {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg().GetEpoch()
	}
	first := next()
	if first != s.Snapshot().Epoch || first == 0 {
		t.Fatalf("first epoch = %d, store %d", first, s.Snapshot().Epoch)
	}
	if err := s.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if e := next(); e != first+1 {
		t.Errorf("after a read: epoch %d, want %d", e, first+1)
	}
}

func TestSkillEventsToProto(t *testing.T) {
	tests := []struct {
		name string
		ev   skill.Event
		want uint64
		nil  bool
	}{
		{name: "changed", ev: skill.Changed{Epoch: 7}, want: 7},
		{name: "snapshot", ev: &skill.Snapshot{Epoch: 3}, want: 3},
		{name: "other", ev: nil, nil: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev := skillWrap(tt.ev)
			if tt.nil {
				if ev != nil {
					t.Errorf("event = %v", ev)
				}
				return
			}
			if ev.GetSkill().GetEpoch() != tt.want {
				t.Errorf("event = %v", ev)
			}
		})
	}
	src := skillSource{store: &skill.Store{}, bus: bus.New()}
	if src.kind() != v1.EventSource_EVENT_SOURCE_SKILL || len(src.topics()) != 1 {
		t.Error("source")
	}
}
