package pagelib

import (
	"maps"
	"slices"
	"testing"
)

func TestCSSClasses(t *testing.T) {
	tests := []struct {
		name, css string
		want      []string
	}{
		{"plain", `.flex{display:flex}`, []string{"flex"}},
		{"an escaped variant", `@media (hover:hover){.hover\:bg-cf-surface:hover{x:y}}`, []string{"hover:bg-cf-surface"}},
		{"an escaped dot and slash", `.size-3\.5{}.w-1\/2{}`, []string{"size-3.5", "w-1/2"}},
		{"a hex escape", `.\32 xl\:flex{}`, []string{"2xl:flex"}},
		{"in a selector list and :where", `.a>:not(:last-child),:where(.group)[x]{}`, []string{"a", "group"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CSSClasses(tt.css)
			for _, w := range tt.want {
				if !got[w] {
					t.Errorf("CSSClasses lacks %q: %v", w, slices.Sorted(maps.Keys(got)))
				}
			}
		})
	}
}

// The served stylesheet, read: what a page reaches for is there, and what the trial found
// missing is not (a page then gets view.inline's unknown-class warning).
func TestUIClass(t *testing.T) {
	for _, c := range []string{"flex", "text-body", "text-cf-text-muted", "hover:bg-cf-surface-raised", "bg-cf-error-surface",
		"size-3.5", "sm:grid-cols-2", "min-h-112", "rounded-md", "group"} {
		if !UIClass(c) {
			t.Errorf("ui.css lacks %s", c)
		}
	}
	for _, c := range []string{"line-through", "rounded", "min-h-[420px]", ""} {
		if UIClass(c) {
			t.Errorf("ui.css has %q", c)
		}
	}
}
