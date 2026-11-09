package ui

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateListRows(t *testing.T) {
	list := func(l string) string { return `{"nodes":[{"key":"todo","list":` + l + `}]}` }
	md := func(l string) string {
		return `{"nodes":[{"key":"md","masterDetail":{"list":` + l + `,"detail":[]}}]}`
	}
	tests := []struct {
		name, view string
		want       string // "" = valid
	}{
		{"checkable with checked rows", list(`{"checkable":true,"rows":[{"key":"a","title":"A","checked":true},{"key":"b","title":"B"}]}`), ""},
		{"reorderable, add, editable", list(`{"reorderable":true,"add":{"placeholder":"Add a task","bottom":true},"rows":[{"key":"a","title":"A","editable":true,"action":{"event":"open"}}]}`), ""},
		{"add on an empty list", list(`{"add":{},"rows":[],"emptyText":"Nothing to do"}`), ""},
		{"dense checkable", list(`{"checkable":true,"dense":true,"rows":[{"key":"a","title":"A","checked":true}]}`), ""},
		{"checked without checkable", list(`{"rows":[{"key":"a","title":"A","checked":true}]}`),
			"nodes[0].list.rows[0].checked: the list is not checkable"},
		{"glyph on a checkable row", list(`{"checkable":true,"rows":[{"key":"a","title":"A","glyph":{"status":"ok"}}]}`),
			"nodes[0].list.rows[0].glyph: a checkable list's checkbox takes the glyph's place"},
		{"long placeholder", list(`{"add":{"placeholder":"` + strings.Repeat("x", MaxLabel+1) + `"},"rows":[]}`),
			"nodes[0].list.add.placeholder:"},
		{"master-detail checkable", md(`{"checkable":true,"rows":[{"key":"a","title":"A"}]}`),
			"nodes[0].masterDetail.list.checkable: a master-detail's list has no checkboxes"},
		{"master-detail reorderable", md(`{"reorderable":true,"rows":[]}`),
			"nodes[0].masterDetail.list.reorderable: a master-detail's list has no drag to reorder"},
		{"master-detail add", md(`{"add":{},"rows":[]}`),
			"nodes[0].masterDetail.list.add: a master-detail's list has no add input"},
		{"master-detail editable row", md(`{"rows":[{"key":"a","title":"A","editable":true}]}`),
			"nodes[0].masterDetail.list.rows[0].editable: a master-detail's list has no editable titles"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var v View
			if err := json.Unmarshal([]byte(tt.view), &v); err != nil {
				t.Fatal(err)
			}
			err := v.Validate()
			if tt.want == "" {
				if err != nil {
					t.Fatalf("Validate: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Validate = %v, want %q", err, tt.want)
			}
		})
	}
}

// The add input counts toward MaxElements.
func TestListAddCountsAsElement(t *testing.T) {
	rows := make([]Row, MaxElements-1)
	for i := range rows {
		rows[i] = NewRow("r"+itoa(i), "x")
	}
	n := NewList("l", rows...) // 1 node + 399 rows = 400
	if err := (View{Nodes: []Node{n}}).Validate(); err != nil {
		t.Fatalf("at the limit: %v", err)
	}
	err := (View{Nodes: []Node{n.WithAddRow("", false)}}).Validate()
	if err == nil || !strings.Contains(err.Error(), "401 elements") {
		t.Fatalf("Validate = %v, want 401 elements", err)
	}
}

func TestListRowBuilders(t *testing.T) {
	n := NewList("todo", NewRow("a", "A").AsChecked(true).AsEditable(), NewRow("b", "B")).
		AsCheckable().AsReorderable().WithAddRow("Add a task", true)
	b, err := json.Marshal(n)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"key":"todo","list":{"rows":[{"key":"a","title":"A","checked":true,"editable":true},{"key":"b","title":"B"}],` +
		`"checkable":true,"reorderable":true,"add":{"placeholder":"Add a task","bottom":true}}}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
	if err := (View{Nodes: []Node{n}}).Validate(); err != nil {
		t.Fatal(err)
	}
	// The builders copy the list: the original node is unchanged, and a non-list node
	// stays as it is.
	plain := NewList("p", NewRow("x", "X"))
	_ = plain.AsCheckable()
	if plain.List.Checkable {
		t.Error("AsCheckable changed its receiver's list")
	}
	if txt := NewText("t", Plain("x")).AsReorderable(); txt.List != nil {
		t.Error("a text node grew a list")
	}
}
