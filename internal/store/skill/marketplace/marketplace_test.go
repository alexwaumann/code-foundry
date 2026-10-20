package marketplace_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace/marketplacetest"
)

func readFixture(t *testing.T) (*marketplace.Catalog, string) {
	t.Helper()
	dir := marketplacetest.Checkout(t)
	var g marketplace.Git
	hist, err := g.History(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	cat, err := marketplace.Read(dir, "ai-marketplace", hist)
	if err != nil {
		t.Fatal(err)
	}
	return cat, dir
}

func find(cat *marketplace.Catalog, kind marketplace.Kind, name string) (marketplace.Entry, bool) {
	i := slices.IndexFunc(cat.Entries, func(e marketplace.Entry) bool { return e.Kind == kind && e.Name == name })
	if i < 0 {
		return marketplace.Entry{}, false
	}
	return cat.Entries[i], true
}

func TestReadEntries(t *testing.T) {
	cat, _ := readFixture(t)
	if cat.Name != "ai-marketplace" || cat.Owner != "AI Platform" {
		t.Errorf("name, owner = %q, %q", cat.Name, cat.Owner)
	}
	var names []string
	for _, e := range cat.Entries {
		names = append(names, string(e.Kind)+":"+e.Name)
	}
	want := []string{
		"plugin:enterprise-data", "plugin:escaper", "skill:haiku-writer", "plugin:lint-kit",
		"skill:pr-review", "plugin:remote-tool", "skill:sql-helper",
	}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("entries = %v\nwant %v", names, want)
	}

	tests := []struct {
		kind marketplace.Kind
		name string
		want marketplace.Entry
	}{
		{marketplace.KindPlugin, "enterprise-data", marketplace.Entry{
			Kind: marketplace.KindPlugin, Tier: marketplace.TierEnterprise, Name: "enterprise-data",
			Description: "Query the data warehouse and its catalog.", By: "Data Platform", Version: "1.4.0",
			LastUpdated: marketplacetest.Catalog, Registry: "ai-marketplace",
			Path:     "enterprise/c1-claude-code-marketplace/enterprise-data",
			Keywords: []string{"sql", "warehouse", "data"}, Skills: []string{"catalog", "query-warehouse"},
		}},
		{marketplace.KindPlugin, "lint-kit", marketplace.Entry{
			Kind: marketplace.KindPlugin, Tier: marketplace.TierCommunity, Name: "lint-kit",
			Description: "Linters for every language.", By: "Index Author", Version: "0.2.1",
			LastUpdated: marketplacetest.Initial, Registry: "ai-marketplace", Path: "community/marketplace/lint-kit",
			Keywords: []string{"lint", "Quality"}, Skills: []string{"lint"},
		}},
		{marketplace.KindPlugin, "remote-tool", marketplace.Entry{
			Kind: marketplace.KindPlugin, Name: "remote-tool", Description: "Lives in another repository.",
			By: "Remote Team", Version: "2.0.0", Registry: "ai-marketplace",
		}},
		{marketplace.KindPlugin, "escaper", marketplace.Entry{
			Kind: marketplace.KindPlugin, Name: "escaper", Description: "Points outside the checkout.", Registry: "ai-marketplace",
		}},
		{marketplace.KindSkill, "pr-review", marketplace.Entry{
			Kind: marketplace.KindSkill, Tier: marketplace.TierEnterprise, Name: "pr-review",
			Description: "Review a pull request against the team's checklist.", By: "Code Quality Guild",
			Version: "20260305", DeclaredVersion: "2.1.0", LastUpdated: marketplacetest.PRReview,
			Registry: "ai-marketplace", Path: "enterprise/skills/pr-review", Keywords: []string{"review", "pull request"},
			SetupScript: "enterprise/skills/pr-review/install.sh",
		}},
		{marketplace.KindSkill, "sql-helper", marketplace.Entry{
			Kind: marketplace.KindSkill, Tier: marketplace.TierEnterprise, Name: "sql-helper",
			Description: "Write SQL for the warehouse.", By: "Jane Doe", Version: "20260110",
			LastUpdated: marketplacetest.Initial, Registry: "ai-marketplace", Path: "enterprise/skills/data/sql-helper",
			Keywords: []string{"sql", "postgres"}, SetupScript: "enterprise/skills/data/sql-helper/scripts/setup.sh",
		}},
		{marketplace.KindSkill, "haiku-writer", marketplace.Entry{
			Kind: marketplace.KindSkill, Tier: marketplace.TierCommunity, Name: "haiku-writer", Version: "20260110",
			LastUpdated: marketplacetest.Initial, Registry: "ai-marketplace", Path: "community/skills/haiku-writer",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := find(cat, tt.kind, tt.name)
			if !ok {
				t.Fatal("missing")
			}
			if got.LastUpdated.IsZero() != tt.want.LastUpdated.IsZero() || !got.LastUpdated.Equal(tt.want.LastUpdated) {
				t.Errorf("LastUpdated = %v, want %v", got.LastUpdated, tt.want.LastUpdated)
			}
			if (got.CommitSHA == "") != tt.want.LastUpdated.IsZero() {
				t.Errorf("CommitSHA = %q", got.CommitSHA)
			}
			got.LastUpdated, got.CommitSHA, tt.want.LastUpdated = time.Time{}, "", time.Time{}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("entry =\n%+v\nwant\n%+v", got, tt.want)
			}
		})
	}
	if got, _ := find(cat, marketplace.KindSkill, "sql-helper"); got.SetupScriptInSkill() != "scripts/setup.sh" {
		t.Errorf("SetupScriptInSkill = %q", got.SetupScriptInSkill())
	}
	if cat.Count(marketplace.KindPlugin) != 4 || cat.Count(marketplace.KindSkill) != 3 {
		t.Errorf("counts = %d plugins, %d skills", cat.Count(marketplace.KindPlugin), cat.Count(marketplace.KindSkill))
	}
	wantIssues := []string{"has no name", "outside the marketplace", "listed twice"}
	for _, w := range wantIssues {
		if !slices.ContainsFunc(cat.Issues, func(s string) bool { return strings.Contains(s, w) }) {
			t.Errorf("issues %q lack %q", cat.Issues, w)
		}
	}
	if len(cat.Issues) != len(wantIssues) {
		t.Errorf("issues = %q", cat.Issues)
	}
}

func TestReadWithoutGit(t *testing.T) {
	cat, err := marketplace.Read(marketplacetest.Fixture(), "plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range cat.Entries {
		if !e.LastUpdated.IsZero() || e.CommitSHA != "" || e.Kind == marketplace.KindSkill && e.Version != "" {
			t.Errorf("%s dated without git: %+v", e.Name, e)
		}
		if e.Registry != "plain" {
			t.Errorf("%s registry = %q", e.Name, e.Registry)
		}
	}
	if cat.Name != "ai-marketplace" || cat.Head != "" {
		t.Errorf("name, head = %q, %q", cat.Name, cat.Head)
	}
}

func TestReadDegrades(t *testing.T) {
	tests := []struct {
		name      string
		index     string // "" = no index file
		wantIssue string
	}{
		{"no index", "", "is missing"},
		{"broken index", "{not json", "is not valid"},
		{"plugins not a list", `{"name": "m", "plugins": 3}`, "is not valid"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			skill := filepath.Join(dir, "community", "skills", "one")
			if err := os.MkdirAll(skill, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: one\n---\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if tt.index != "" {
				if err := os.MkdirAll(filepath.Join(dir, ".claude-plugin"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, ".claude-plugin", "marketplace.json"), []byte(tt.index), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			cat, err := marketplace.Read(dir, "m", nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(cat.Entries) != 1 || cat.Entries[0].Name != "one" {
				t.Errorf("entries = %+v", cat.Entries)
			}
			if len(cat.Issues) != 1 || !strings.Contains(cat.Issues[0], tt.wantIssue) {
				t.Errorf("issues = %q, want one with %q", cat.Issues, tt.wantIssue)
			}
		})
	}
	if _, err := marketplace.Read(filepath.Join(t.TempDir(), "gone"), "m", nil); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("missing checkout: %v", err)
	}
}

func TestPluginSkillLists(t *testing.T) {
	// A plugin whose source is the checkout's root lists its skills explicitly (the
	// anthropics/skills shape); plugin.json may give a string.
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".claude-plugin/marketplace.json", `{"name": "m", "plugins": [
		{"name": "docs", "source": "./", "skills": ["./skills/pdf", "./skills/docx"]},
		{"name": "art", "source": "./art"},
		{"name": "sneaky", "source": "./art", "skills": ["../skills"]}
	]}`)
	write("skills/pdf/SKILL.md", "---\nname: pdf\n---\n")
	write("skills/docx/SKILL.md", "---\nname: docx\n---\n")
	write("skills/xlsx/SKILL.md", "---\nname: xlsx\n---\n")
	write("art/.claude-plugin/plugin.json", `{"name": "art", "skills": "./brushes", "author": "Painter"}`)
	write("art/brushes/oil/SKILL.md", "---\nname: oil\n---\n")
	write("art/skills/ignored/SKILL.md", "---\nname: ignored\n---\n")
	cat, err := marketplace.Read(dir, "m", nil)
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		skills []string
		by     string
	}{
		{"docs", []string{"docx", "pdf"}, ""},
		{"art", []string{"oil"}, "Painter"},
		{"sneaky", nil, "Painter"},
	}
	for _, tt := range tests {
		e, ok := find(cat, marketplace.KindPlugin, tt.name)
		if !ok {
			t.Fatalf("%s missing", tt.name)
		}
		if !reflect.DeepEqual(e.Skills, tt.skills) || e.By != tt.by {
			t.Errorf("%s: skills %v by %q, want %v by %q", tt.name, e.Skills, e.By, tt.skills, tt.by)
		}
	}
	if len(cat.Issues) != 1 || !strings.Contains(cat.Issues[0], "outside the plugin") {
		t.Errorf("issues = %q", cat.Issues)
	}
}
