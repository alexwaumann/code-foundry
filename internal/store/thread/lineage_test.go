package thread

import (
	"fmt"
	"slices"
	"testing"
	"time"
)

func TestSubtree(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	// A chain s-0 → s-1 → … → s-11, each created by the one before.
	var chain []LineageNode
	for i := 1; i <= 11; i++ {
		chain = append(chain, LineageNode{ID: fmt.Sprintf("s-%d", i), CreatedBy: fmt.Sprintf("s-%d", i-1), CreatedAt: at(i)})
	}
	tests := []struct {
		name  string
		nodes []LineageNode
		root  string
		want  []string // "<id>@<depth>" in order
	}{
		{
			name: "two levels, each lead before its workers, siblings oldest first",
			nodes: []LineageNode{
				{ID: "s-orch", CreatedAt: at(0)},
				{ID: "s-leadb", CreatedBy: "s-orch", CreatedAt: at(2)},
				{ID: "s-leada", CreatedBy: "s-orch", CreatedAt: at(1)},
				{ID: "s-b1", CreatedBy: "s-leadb", CreatedAt: at(4)},
				{ID: "s-a2", CreatedBy: "s-leada", CreatedAt: at(5)},
				{ID: "s-a1", CreatedBy: "s-leada", CreatedAt: at(3)},
				{ID: "s-other", CreatedAt: at(0)},
				{ID: "s-x", CreatedBy: "s-other", CreatedAt: at(1)},
			},
			root: "s-orch",
			want: []string{"s-orch@0", "s-leada@1", "s-a1@2", "s-a2@2", "s-leadb@1", "s-b1@2"},
		},
		{
			name:  "a lead's own team",
			nodes: []LineageNode{{ID: "s-orch"}, {ID: "s-lead", CreatedBy: "s-orch"}, {ID: "s-w", CreatedBy: "s-lead"}},
			root:  "s-lead",
			want:  []string{"s-lead@0", "s-w@1"},
		},
		{
			name:  "same creation time: by id",
			nodes: []LineageNode{{ID: "s-r"}, {ID: "s-z", CreatedBy: "s-r"}, {ID: "s-y", CreatedBy: "s-r"}},
			root:  "s-r",
			want:  []string{"s-r@0", "s-y@1", "s-z@1"},
		},
		{
			name:  "a thread with no children is its own subtree",
			nodes: []LineageNode{{ID: "s-r"}},
			root:  "s-r",
			want:  []string{"s-r@0"},
		},
		{
			name:  "a root not among the nodes still leads its children",
			nodes: []LineageNode{{ID: "s-k", CreatedBy: "s-gone"}},
			root:  "s-gone",
			want:  []string{"s-gone@0", "s-k@1"},
		},
		{
			name: "a cycle through the root is cut where it closes",
			nodes: []LineageNode{
				{ID: "s-a", CreatedBy: "s-c"}, {ID: "s-b", CreatedBy: "s-a"}, {ID: "s-c", CreatedBy: "s-b"},
			},
			root: "s-a",
			want: []string{"s-a@0", "s-b@1", "s-c@2"},
		},
		{
			name:  "a thread recorded as its own creator",
			nodes: []LineageNode{{ID: "s-a", CreatedBy: "s-a"}, {ID: "s-b", CreatedBy: "s-a"}},
			root:  "s-a",
			want:  []string{"s-a@0", "s-b@1"},
		},
		{
			name:  "deeper than the cap is left out",
			nodes: append([]LineageNode{{ID: "s-0"}}, chain...),
			root:  "s-0",
			want:  []string{"s-0@0", "s-1@1", "s-2@2", "s-3@3", "s-4@4", "s-5@5", "s-6@6", "s-7@7", "s-8@8"},
		},
		{name: "no root", nodes: []LineageNode{{ID: "s-a"}}, root: "", want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, e := range Subtree(tt.nodes, tt.root) {
				got = append(got, fmt.Sprintf("%s@%d", e.ID, e.Depth))
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("Subtree = %v, want %v", got, tt.want)
			}
		})
	}
}

// DescendantsOf composes with the other filters: archived threads are left out unless
// asked for, removed ones are never listed but keep the line, the limit keeps the most
// recently active, and the answer is in tree order with depths.
func TestFilterLineage(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	threads := []Thread{
		{ID: "s-orch", CreatedAt: at(0), LastActivityAt: at(50), Status: StatusIdle},
		{ID: "s-leada", CreatedAt: at(1), LastActivityAt: at(20), CreatedBy: "s-orch", Status: StatusIdle},
		{ID: "s-a1", CreatedAt: at(3), LastActivityAt: at(30), CreatedBy: "s-leada", Status: StatusBusy},
		{ID: "s-a2", CreatedAt: at(4), LastActivityAt: at(40), CreatedBy: "s-leada", Status: StatusIdle, ArchivedAt: at(41)},
		{ID: "s-leadb", CreatedAt: at(2), LastActivityAt: at(10), CreatedBy: "s-orch", Status: StatusIdle, ArchivedAt: at(11)},
		{ID: "s-b1", CreatedAt: at(5), LastActivityAt: at(12), CreatedBy: "s-leadb", Status: StatusBusy},
		{ID: "s-c1", CreatedAt: at(6), LastActivityAt: at(13), CreatedBy: "s-leadc", Status: StatusIdle},
		{ID: "s-plugin", CreatedAt: at(7), CreatedBy: "s-orch", Owner: "plugin:hello"},
		{ID: "s-stranger", CreatedAt: at(0), LastActivityAt: at(60)},
	}
	// Lead C was removed; its worker s-c1 is still the orchestrator's, in Lead C's place
	// among the orchestrator's children.
	removed := []RemovedThread{{ID: "s-leadc", CreatedBy: "s-orch", CreatedAt: at(2), RemovedAt: at(8)}}
	tests := []struct {
		name string
		o    ListOptions
		want []string // "<id>@<depth>"
	}{
		{name: "archived left out by default; an archived lead's live worker stays",
			o:    ListOptions{DescendantsOf: "s-orch"},
			want: []string{"s-orch@0", "s-leada@1", "s-a1@2", "s-b1@2", "s-c1@2"}},
		{name: "all includes archived",
			o:    ListOptions{DescendantsOf: "s-orch", All: true},
			want: []string{"s-orch@0", "s-leada@1", "s-a1@2", "s-a2@2", "s-leadb@1", "s-b1@2", "s-c1@2", "s-plugin@1"}},
		{name: "archived includes archived, not owned",
			o:    ListOptions{DescendantsOf: "s-orch", IncludeArchived: true},
			want: []string{"s-orch@0", "s-leada@1", "s-a1@2", "s-a2@2", "s-leadb@1", "s-b1@2", "s-c1@2"}},
		{name: "a lead's subtree",
			o:    ListOptions{DescendantsOf: "s-leada", All: true},
			want: []string{"s-leada@0", "s-a1@1", "s-a2@1"}},
		{name: "composes with a status",
			o:    ListOptions{DescendantsOf: "s-orch", Status: StatusBusy},
			want: []string{"s-a1@2", "s-b1@2"}},
		{name: "composes with created by",
			o:    ListOptions{DescendantsOf: "s-orch", CreatedBy: "s-leada", All: true},
			want: []string{"s-a1@2", "s-a2@2"}},
		{name: "the limit keeps the most recently active, then tree order",
			o:    ListOptions{DescendantsOf: "s-orch", Limit: 3},
			want: []string{"s-orch@0", "s-leada@1", "s-a1@2"}},
		{name: "a removed root still leads its children",
			o:    ListOptions{DescendantsOf: "s-leadc"},
			want: []string{"s-c1@1"}},
		{name: "an unknown root: nothing",
			o:    ListOptions{DescendantsOf: "s-nope"},
			want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, th := range FilterLineage(threads, removed, tt.o) {
				got = append(got, fmt.Sprintf("%s@%d", th.ID, th.Depth))
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("FilterLineage = %v, want %v", got, tt.want)
			}
		})
	}
	if got := FilterRemoved(removed, ListOptions{DescendantsOf: "s-orch"}); len(got) != 0 {
		t.Errorf("FilterRemoved with DescendantsOf = %v, want none", got)
	}
}
