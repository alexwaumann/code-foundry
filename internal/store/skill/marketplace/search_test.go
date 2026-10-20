package marketplace

import (
	"fmt"
	"reflect"
	"testing"
)

func TestSearch(t *testing.T) {
	entries := []Entry{
		{Kind: KindSkill, Tier: TierEnterprise, Name: "sql-helper", Description: "Write SQL.", By: "Jane", Registry: "a"},
		{Kind: KindPlugin, Tier: TierEnterprise, Name: "enterprise-data", Description: "Warehouse tools.", Keywords: []string{"sql"}, Registry: "a"},
		{Kind: KindSkill, Tier: TierCommunity, Name: "sql", Description: "Plain SQL.", Registry: "a"},
		{Kind: KindSkill, Tier: TierCommunity, Name: "mysql-tuner", Description: "Tune MySQL.", Registry: "a"},
		{Kind: KindSkill, Tier: TierCommunity, Name: "haiku", Description: "Poems.", By: "SQL Poets", Registry: "a"},
		{Kind: KindPlugin, Tier: TierCommunity, Name: "lint-kit", Description: "Linters.", Registry: "a"},
		{Kind: KindSkill, Tier: TierEnterprise, Name: "pr-review", Description: "Review a pull request.", Keywords: []string{"github"}, Registry: "a"},
		{Kind: KindPlugin, Tier: TierCommunity, Name: "sql", Description: "SQL plugin.", Registry: "a"},
	}
	names := func(r Result) []string {
		var out []string
		for _, e := range r.Entries {
			out = append(out, string(e.Kind[0])+":"+e.Name)
		}
		return out
	}
	tests := []struct {
		name  string
		q     Query
		want  []string
		total int
	}{
		{"empty sorts by name", Query{}, []string{
			"p:enterprise-data", "s:haiku", "p:lint-kit", "s:mysql-tuner", "s:pr-review", "p:sql", "s:sql", "s:sql-helper",
		}, 8},
		{"name hits first: exact, prefix, contains, then elsewhere", Query{Text: "SQL"}, []string{
			"p:sql", "s:sql", "s:sql-helper", "s:mysql-tuner", "p:enterprise-data", "s:haiku",
		}, 6},
		{"tier filter", Query{Text: "sql", Tier: TierEnterprise}, []string{"s:sql-helper", "p:enterprise-data"}, 2},
		{"kind filter", Query{Text: "sql", Kind: KindPlugin}, []string{"p:sql", "p:enterprise-data"}, 2},
		{"both filters", Query{Tier: TierCommunity, Kind: KindPlugin}, []string{"p:lint-kit", "p:sql"}, 2},
		{"description", Query{Text: "poems"}, []string{"s:haiku"}, 1},
		{"keyword", Query{Text: "GitHub"}, []string{"s:pr-review"}, 1},
		{"by", Query{Text: "jane"}, []string{"s:sql-helper"}, 1},
		{"every word must match", Query{Text: "pull review"}, []string{"s:pr-review"}, 1},
		{"words across fields", Query{Text: "sql   poets"}, []string{"s:haiku"}, 1},
		{"no match", Query{Text: "nothing"}, nil, 0},
		{"limit keeps the total", Query{Text: "sql", Limit: 2}, []string{"p:sql", "s:sql"}, 6},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Search(entries, tt.q)
			if !reflect.DeepEqual(names(got), tt.want) || got.Total != tt.total {
				t.Errorf("Search(%+v) = %v (%d), want %v (%d)", tt.q, names(got), got.Total, tt.want, tt.total)
			}
		})
	}
}

func TestSearchLimits(t *testing.T) {
	var many []Entry
	for i := range MaxLimit + 20 {
		many = append(many, Entry{Kind: KindSkill, Name: fmt.Sprintf("s%04d", i)})
	}
	tests := []struct {
		limit, want int
	}{
		{0, DefaultLimit},
		{-3, DefaultLimit},
		{7, 7},
		{MaxLimit + 1, MaxLimit},
	}
	for _, tt := range tests {
		got := Search(many, Query{Limit: tt.limit})
		if len(got.Entries) != tt.want || got.Total != len(many) {
			t.Errorf("limit %d: %d entries (total %d), want %d", tt.limit, len(got.Entries), got.Total, tt.want)
		}
	}
}
