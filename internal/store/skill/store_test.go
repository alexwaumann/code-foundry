package skill_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/skill"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
	"github.com/alexwaumann/code-foundry/internal/store/skill/skilltest"
)

type harness struct {
	store               *skill.Store
	claude              *skilltest.Claude
	db                  *sql.DB
	bus                 *bus.Bus
	checkout            string
	skillsDir, disabled string
}

var now = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{
		claude: skilltest.New(), db: dbtest.Open(t), bus: bus.New(), checkout: marketplacetest.Checkout(t),
		skillsDir: filepath.Join(t.TempDir(), "skills"), disabled: filepath.Join(t.TempDir(), "disabled"),
	}
	h.claude.Set([]skilltest.Marketplace{{Name: "ai-marketplace", Source: "github", Repo: "acme/ai-marketplace", InstallLocation: h.checkout}}, nil)
	s, err := skill.New(skill.Options{
		DB: h.db, Claude: h.claude, SkillsDir: h.skillsDir, DisabledDir: h.disabled, Bus: h.bus,
		Now: func() time.Time { return now }, Log: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	h.store = s
	return h
}

func (h *harness) load(t *testing.T) {
	t.Helper()
	if err := h.store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func writeSkill(t *testing.T, dir, name, frontmatter string, extra map[string]string) {
	t.Helper()
	d := filepath.Join(dir, name)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if frontmatter != "-" {
		if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte("---\n"+frontmatter+"\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for rel, content := range extra {
		p := filepath.Join(d, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestNewRequires(t *testing.T) {
	if _, err := skill.New(skill.Options{}); err == nil {
		t.Fatal("New without options succeeded")
	}
}

func TestLoad(t *testing.T) {
	h := newHarness(t)
	sub := bus.Subscribe[skill.Event](h.bus, 8)
	defer sub.Close()
	if snap := h.store.Snapshot(); snap.Epoch != 0 || len(snap.Registries) != 0 {
		t.Fatalf("before Load: %+v", snap)
	}
	h.load(t)
	regs := h.store.Registries()
	if len(regs) != 1 {
		t.Fatalf("registries = %+v", regs)
	}
	r := regs[0]
	head := marketplacetest.Git(t, h.checkout, time.Time{}, "rev-parse", "HEAD")
	if r.Name != "ai-marketplace" || r.Repo != "acme/ai-marketplace" || r.Source != "github" || r.Dir != h.checkout ||
		r.Owner != "AI Platform" || r.Plugins != 4 || r.Skills != 3 || r.Head != head || r.Shallow ||
		!r.ReadAt.Equal(now) || !r.RefreshedAt.IsZero() || r.Err != "" || len(r.Issues) != 3 {
		t.Errorf("registry = %+v", r)
	}
	if ev := <-sub.C(); ev != (skill.Changed{Epoch: 1}) || h.store.Snapshot().Epoch != 1 {
		t.Errorf("event %v, epoch %d", ev, h.store.Snapshot().Epoch)
	}
	if got := h.store.Search(marketplace.Query{Text: "sql"}); got.Total != 2 || got.Entries[0].Name != "sql-helper" {
		t.Errorf("search = %+v", got)
	}
	if got := h.store.Search(marketplace.Query{Kind: marketplace.KindSkill, Tier: marketplace.TierCommunity}); got.Total != 1 || got.Entries[0].Name != "haiku-writer" {
		t.Errorf("filtered search = %+v", got)
	}
	// No network on a read: only the two list calls.
	if n := len(h.claude.Calls()); n != 2 || h.claude.CallCount("plugin marketplace update") != 0 {
		t.Errorf("calls = %v", h.claude.Calls())
	}
	h.load(t)
	if ev := <-sub.C(); ev != (skill.Changed{Epoch: 2}) {
		t.Errorf("second load published %v", ev)
	}
}

func TestEntry(t *testing.T) {
	h := newHarness(t)
	// A standalone skill with a plugin's name.
	marketplacetest.Commit(t, h.checkout, time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), map[string]string{
		"community/skills/lint-kit/SKILL.md": "---\nname: lint-kit\n---\n",
	})
	h.load(t)
	tests := []struct {
		name     string
		kind     marketplace.Kind
		wantKind marketplace.Kind
		wantErr  error
		wantMsg  string
	}{
		{"enterprise-data", "", marketplace.KindPlugin, nil, ""},
		{"pr-review", "", marketplace.KindSkill, nil, ""},
		{"pr-review", marketplace.KindSkill, marketplace.KindSkill, nil, ""},
		{"pr-review", marketplace.KindPlugin, "", skill.ErrNotFound, `no plugin named "pr-review"`},
		{"lint-kit", "", "", skill.ErrAmbiguous, "--kind plugin or --kind skill"},
		{"lint-kit", marketplace.KindPlugin, marketplace.KindPlugin, nil, ""},
		{"lint-kit", marketplace.KindSkill, marketplace.KindSkill, nil, ""},
		{"PR-Review", "", "", skill.ErrNotFound, `no plugin or skill named "PR-Review"`},
		{"inner", "", "", skill.ErrNotFound, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name+"/"+string(tt.kind), func(t *testing.T) {
			e, err := h.store.Entry(tt.name, tt.kind)
			if !errors.Is(err, tt.wantErr) || tt.wantErr == nil && err != nil {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil && !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("err = %q, want it to contain %q", err, tt.wantMsg)
			}
			if err == nil && (e.Kind != tt.wantKind || e.Name != tt.name) {
				t.Errorf("entry = %s %s", e.Kind, e.Name)
			}
		})
	}
	var amb *skill.AmbiguousError
	if _, err := h.store.Entry("lint-kit", ""); !errors.As(err, &amb) || len(amb.Choices) != 2 {
		t.Errorf("ambiguous err = %#v", err)
	}
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func TestInstalled(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t)
	setup := "#!/bin/sh\necho setup\n"
	writeSkill(t, h.skillsDir, "pr-review", "name: pr-review\ndescription: Installed copy.", nil)
	writeSkill(t, h.skillsDir, "sql-helper-done", "name: sql-helper", map[string]string{"scripts/setup.sh": setup})
	writeSkill(t, h.skillsDir, "sql-helper-changed", "name: sql-helper", map[string]string{"scripts/setup.sh": setup + "# edited\n"})
	writeSkill(t, h.skillsDir, "mine", "description: My own skill.", nil)
	writeSkill(t, h.skillsDir, "synced", "name: synced", nil)
	writeSkill(t, h.skillsDir, ".trash", "name: trash", nil)
	writeSkill(t, h.skillsDir, "not-a-skill", "-", map[string]string{"README.md": "x"})
	writeSkill(t, h.disabled, "haiku-writer", "-", map[string]string{"SKILL.md": "# Haiku\n"})
	recs := []skill.Record{
		{Name: "pr-review", Registry: "ai-marketplace", Path: "enterprise/skills/pr-review", Tier: marketplace.TierEnterprise,
			CommitSHA: "aaa", CommitAt: marketplacetest.Initial, InstalledAt: now},
		{Name: "sql-helper-done", Registry: "ai-marketplace", Path: "enterprise/skills/data/sql-helper", Tier: marketplace.TierEnterprise,
			CommitAt: marketplacetest.Initial, SetupScript: "scripts/setup.sh", SetupSHA256: sha(setup), SetupDoneAt: now, InstalledAt: now},
		{Name: "sql-helper-changed", Registry: "ai-marketplace", Path: "enterprise/skills/data/sql-helper",
			CommitAt: marketplacetest.Initial, SetupScript: "scripts/setup.sh", SetupSHA256: sha(setup), SetupDoneAt: now, InstalledAt: now},
		{Name: "haiku-writer", Registry: "ai-marketplace", Path: "community/skills/haiku-writer", Tier: marketplace.TierCommunity,
			CommitAt: marketplacetest.Initial, SetupScript: "install.sh", InstalledAt: now},
		{Name: "gone", Registry: "ai-marketplace", Path: "community/skills/gone", CommitAt: marketplacetest.Initial, InstalledAt: now},
	}
	for _, r := range recs {
		if err := skill.SaveRecord(ctx, h.db, r); err != nil {
			t.Fatal(err)
		}
	}
	h.claude.Set(h.claude.Marketplaces, []skilltest.Plugin{
		{ID: "enterprise-data@ai-marketplace", Version: "1.3.0", Scope: "user", Enabled: true, InstallPath: "/p/ed", LastUpdated: "2026-10-01T10:00:00.000Z"},
		{ID: "lint-kit@ai-marketplace", Version: "0.2.1", Scope: "user", Enabled: false, InstallPath: "/p/lk"},
		{ID: "frontend@claude-plugins-official", Version: "abc123", Scope: "project", Enabled: true, InstallPath: "/p/fe"},
	})
	h.load(t)

	type row struct {
		ID, Registry, Version, Description, Dir string
		Enabled, Local, Missing, NeedsSetup     bool
		Update                                  string
		Skills                                  []string
	}
	got := map[string]row{}
	for _, in := range h.store.Installed() {
		r := row{ID: in.ID(), Registry: in.Registry, Version: in.Version, Description: in.Description, Dir: in.Dir,
			Enabled: in.Enabled, Local: in.Local, Missing: in.Missing, NeedsSetup: in.NeedsSetup, Skills: in.Skills}
		if in.Update != nil {
			r.Update = in.Update.Version
		}
		got[string(in.Kind)+" "+in.Name] = r
	}
	want := map[string]row{
		"plugin enterprise-data": {ID: "enterprise-data@ai-marketplace", Registry: "ai-marketplace", Version: "1.3.0",
			Description: "Query the data warehouse and its catalog.", Dir: "/p/ed", Enabled: true, Update: "1.3.9",
			Skills: []string{"catalog", "query-warehouse"}},
		"plugin lint-kit": {ID: "lint-kit@ai-marketplace", Registry: "ai-marketplace", Version: "0.2.1",
			Description: "Linters for every language.", Dir: "/p/lk", Skills: []string{"lint"}},
		"plugin frontend": {ID: "frontend@claude-plugins-official", Registry: "claude-plugins-official", Version: "abc123",
			Dir: "/p/fe", Enabled: true},
		"skill pr-review": {ID: "pr-review", Registry: "ai-marketplace", Version: "20260110", Description: "Installed copy.",
			Dir: filepath.Join(h.skillsDir, "pr-review"), Enabled: true, Update: "20260305"},
		"skill sql-helper-done": {ID: "sql-helper-done", Registry: "ai-marketplace", Version: "20260110",
			Description: "Write SQL for the warehouse.", Dir: filepath.Join(h.skillsDir, "sql-helper-done"), Enabled: true},
		"skill sql-helper-changed": {ID: "sql-helper-changed", Registry: "ai-marketplace", Version: "20260110",
			Description: "Write SQL for the warehouse.", Dir: filepath.Join(h.skillsDir, "sql-helper-changed"), Enabled: true, NeedsSetup: true},
		"skill haiku-writer": {ID: "haiku-writer", Registry: "ai-marketplace", Version: "20260110",
			Dir: filepath.Join(h.disabled, "haiku-writer"), NeedsSetup: true},
		"skill mine": {ID: "mine", Description: "My own skill.", Dir: filepath.Join(h.skillsDir, "mine"), Enabled: true, Local: true},
		"skill gone": {ID: "gone", Registry: "ai-marketplace", Version: "20260110", Missing: true},
	}
	if !reflect.DeepEqual(got, want) {
		for k := range want {
			if !reflect.DeepEqual(got[k], want[k]) {
				t.Errorf("%s:\n got %+v\nwant %+v", k, got[k], want[k])
			}
		}
		for k := range got {
			if _, ok := want[k]; !ok {
				t.Errorf("unexpected %s: %+v", k, got[k])
			}
		}
	}
	var names []string
	for _, in := range h.store.Installed() {
		names = append(names, in.Name)
	}
	if !slices.IsSorted(names) {
		t.Errorf("installed not sorted: %v", names)
	}

	// Forgetting a record turns a recorded skill local.
	if err := skill.DeleteRecord(ctx, h.db, "pr-review"); err != nil {
		t.Fatal(err)
	}
	if rs, err := skill.LoadRecords(ctx, h.db); err != nil || len(rs) != len(recs)-1 {
		t.Fatalf("records = %d, %v", len(rs), err)
	}
	h.load(t)
	i := slices.IndexFunc(h.store.Installed(), func(in skill.Installed) bool { return in.Name == "pr-review" })
	if in := h.store.Installed()[i]; !in.Local || in.Update != nil || in.Registry != "" {
		t.Errorf("after forgetting: %+v", in)
	}
}

// TestPluginUpdateOffer: a plugin's offer compares the checkout's plugin.json version
// with the installed copy's (Claude Code installs and reports plugin.json's), so an
// index version that differs from plugin.json (the fixture's enterprise-data: 1.4.0 in
// marketplace.json, 1.3.9 in plugin.json) never offers an update `claude plugin update`
// cannot bring. A checkout without plugin.json (lint-kit) falls back to the index.
func TestPluginUpdateOffer(t *testing.T) {
	manifest := func(t *testing.T, version string) string {
		t.Helper()
		dir := t.TempDir()
		if version != "-" {
			if err := os.MkdirAll(filepath.Join(dir, ".claude-plugin"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, ".claude-plugin", "plugin.json"), []byte(`{"name":"x","version":"`+version+`"}`), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	tests := []struct {
		name      string
		id        string
		listed    string // the version `claude plugin list` reports
		installed string // the installed copy's plugin.json version; "-" for none
		want      string // the offer; "" for none
	}{
		{name: "plugin.json versions agree, index newer: no offer", id: "enterprise-data@ai-marketplace", listed: "1.3.9", installed: "1.3.9"},
		{name: "installed plugin.json older", id: "enterprise-data@ai-marketplace", listed: "1.3.0", installed: "1.3.0", want: "1.3.9"},
		{name: "installed plugin.json wins over the list", id: "enterprise-data@ai-marketplace", listed: "1.0.0", installed: "1.3.9"},
		{name: "no installed plugin.json: the listed version", id: "enterprise-data@ai-marketplace", listed: "1.3.0", installed: "-", want: "1.3.9"},
		{name: "installed newer than the checkout", id: "enterprise-data@ai-marketplace", listed: "2.0.0", installed: "2.0.0"},
		{name: "a commit prefix never compares", id: "enterprise-data@ai-marketplace", listed: "dbd4588f9e10", installed: "-"},
		{name: "checkout without plugin.json: index newer", id: "lint-kit@ai-marketplace", listed: "0.2.0", installed: "-", want: "0.2.1"},
		{name: "checkout without plugin.json: index the same", id: "lint-kit@ai-marketplace", listed: "0.2.1", installed: "0.1.0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.claude.Set(h.claude.Marketplaces, []skilltest.Plugin{{ID: tt.id, Version: tt.listed, Scope: "user", Enabled: true, InstallPath: manifest(t, tt.installed)}})
			h.load(t)
			in := h.store.Installed()
			if len(in) != 1 {
				t.Fatalf("installed = %+v", in)
			}
			got := ""
			if in[0].Update != nil {
				got = in[0].Update.Version
			}
			if got != tt.want {
				t.Errorf("offer = %q, want %q", got, tt.want)
			}
			if wantBy := map[string]string{"enterprise-data": "Data Platform", "lint-kit": "Index Author"}[in[0].Name]; in[0].By != wantBy {
				t.Errorf("by = %q, want %q", in[0].By, wantBy)
			}
			if ups := h.store.Updates(""); (len(ups) == 1) != (tt.want != "") {
				t.Errorf("updates = %+v", ups)
			}
		})
	}
}

func TestLoadFailures(t *testing.T) {
	boom := errors.New("boom")
	t.Run("marketplace list fails: last good list stays", func(t *testing.T) {
		h := newHarness(t)
		h.load(t)
		h.claude.Fail("plugin marketplace list", boom)
		if err := h.store.Load(context.Background()); !errors.Is(err, boom) {
			t.Fatalf("Load = %v", err)
		}
		snap := h.store.Snapshot()
		if snap.Err != "boom" || len(snap.Registries) != 1 || h.store.Search(marketplace.Query{}).Total != 7 {
			t.Errorf("snapshot err %q, %d registries", snap.Err, len(snap.Registries))
		}
		h.claude.Fail("plugin marketplace list", nil)
		h.load(t)
		if h.store.Snapshot().Err != "" {
			t.Error("error stuck")
		}
	})
	t.Run("plugin list fails: skills still listed", func(t *testing.T) {
		h := newHarness(t)
		writeSkill(t, h.skillsDir, "mine", "name: mine", nil)
		h.claude.Fail("plugin list", boom)
		if err := h.store.Load(context.Background()); !errors.Is(err, boom) {
			t.Fatalf("Load = %v", err)
		}
		snap := h.store.Snapshot()
		if snap.PluginsErr != "boom" || len(snap.Installed) != 1 || len(snap.Registries) != 1 {
			t.Errorf("snapshot = %+v", snap)
		}
	})
	t.Run("checkout gone: last good catalog stays", func(t *testing.T) {
		h := newHarness(t)
		h.load(t)
		moved := h.checkout + ".moved"
		if err := os.Rename(h.checkout, moved); err != nil {
			t.Fatal(err)
		}
		if err := h.store.Load(context.Background()); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("Load = %v", err)
		}
		r := h.store.Registries()[0]
		if r.Err == "" || r.Plugins != 4 || !r.ReadAt.Equal(now) || h.store.Search(marketplace.Query{}).Total != 7 {
			t.Errorf("registry = %+v", r)
		}
	})
	t.Run("not a git checkout: undated, an issue", func(t *testing.T) {
		h := newHarness(t)
		h.claude.Set([]skilltest.Marketplace{{Name: "plain", InstallLocation: marketplacetest.Fixture()}}, nil)
		h.load(t)
		r := h.store.Registries()[0]
		if r.Head != "" || !slices.ContainsFunc(r.Issues, func(s string) bool { return strings.Contains(s, "not a git clone") }) {
			t.Errorf("registry = %+v", r)
		}
		if e, err := h.store.Entry("pr-review", ""); err != nil || e.Version != "" || !e.LastUpdated.IsZero() {
			t.Errorf("entry = %+v, %v", e, err)
		}
	})
	t.Run("no marketplaces", func(t *testing.T) {
		h := newHarness(t)
		h.claude.Set(nil, nil)
		h.load(t)
		if snap := h.store.Snapshot(); len(snap.Registries) != 0 || snap.Err != "" || h.store.Search(marketplace.Query{}).Total != 0 {
			t.Errorf("snapshot = %+v", snap)
		}
	})
}

func TestRefresh(t *testing.T) {
	ctx := context.Background()
	later := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	t.Run("updates then re-reads", func(t *testing.T) {
		h := newHarness(t)
		h.load(t)
		h.claude.OnUpdate = func(string) error {
			marketplacetest.Commit(t, h.checkout, later, map[string]string{"community/skills/new-one/SKILL.md": "---\nname: new-one\n---\n"})
			return nil
		}
		if err := h.store.Refresh(ctx); err != nil {
			t.Fatal(err)
		}
		if n := h.claude.CallCount("plugin marketplace update ai-marketplace"); n != 1 {
			t.Errorf("updates = %d", n)
		}
		r := h.store.Registries()[0]
		if r.Skills != 4 || !r.RefreshedAt.Equal(now) || r.Err != "" {
			t.Errorf("registry = %+v", r)
		}
		if e, err := h.store.Entry("new-one", marketplace.KindSkill); err != nil || e.Version != "20260901" {
			t.Errorf("new entry = %+v, %v", e, err)
		}
	})

	t.Run("a failed update is reported and the checkout still read", func(t *testing.T) {
		h := newHarness(t)
		boom := errors.New("network down")
		h.claude.Fail("plugin marketplace update", boom)
		if err := h.store.Refresh(ctx); !errors.Is(err, boom) {
			t.Fatalf("Refresh = %v", err)
		}
		r := h.store.Registries()[0]
		if r.Err != "network down" || r.Plugins != 4 || !r.RefreshedAt.IsZero() {
			t.Errorf("registry = %+v", r)
		}
		h.claude.Fail("plugin marketplace update", nil)
		if err := h.store.Refresh(ctx); err != nil {
			t.Fatal(err)
		}
		if r := h.store.Registries()[0]; r.Err != "" || !r.RefreshedAt.Equal(now) {
			t.Errorf("after a good refresh: %+v", r)
		}
	})

	t.Run("a shallow checkout gets its history", func(t *testing.T) {
		h := newHarness(t)
		clone := filepath.Join(t.TempDir(), "clone")
		marketplacetest.Git(t, filepath.Dir(clone), time.Time{}, "clone", "-q", "--depth", "1", "file://"+h.checkout, clone)
		h.claude.Set([]skilltest.Marketplace{{Name: "ai-marketplace", InstallLocation: clone}}, nil)
		h.load(t)
		if r := h.store.Registries()[0]; !r.Shallow || !slices.ContainsFunc(r.Issues, func(s string) bool { return strings.Contains(s, "shallow") }) {
			t.Fatalf("registry = %+v", r)
		}
		if e, _ := h.store.Entry("sql-helper", ""); e.Version != "20260401" {
			t.Errorf("shallow version = %q, want the boundary commit's", e.Version)
		}
		if err := h.store.Refresh(ctx); err != nil {
			t.Fatal(err)
		}
		if r := h.store.Registries()[0]; r.Shallow {
			t.Errorf("still shallow: %+v", r)
		}
		if e, _ := h.store.Entry("sql-helper", ""); e.Version != "20260110" {
			t.Errorf("version after refresh = %q", e.Version)
		}
	})

	t.Run("list fails", func(t *testing.T) {
		h := newHarness(t)
		h.claude.Fail("plugin marketplace list", errors.New("no claude"))
		if err := h.store.Refresh(ctx); err == nil || h.store.Snapshot().Err != "no claude" {
			t.Errorf("Refresh = %v, snapshot err %q", err, h.store.Snapshot().Err)
		}
	})
}
