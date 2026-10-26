package command

import (
	"slices"
	"testing"
)

func TestArbitraryClassWarning(t *testing.T) {
	tests := []struct {
		name, text, want string
	}{
		{"a JSX className", `<div className="flex min-h-[420px] gap-2">`, "min-h-[420px]"},
		{"a class attribute, variant and negative", `<div class='p-2 md:-mt-[3px]'>`, "md:-mt-[3px]"},
		{"cn's first string", "<div className={cn(\"grid grid-cols-[2fr_1fr]\", x)}>", "grid-cols-[2fr_1fr]"},
		{"a template string", "<div className={`h-[600px] ${open}`}>", "h-[600px]"},
		{"an arbitrary variant", `<div className="data-[state=open]:flex">`, "data-[state=open]:flex"},
		{"the scale is fine", `<div className="min-h-112 max-h-96 w-1/2 p-0.5">`, ""},
		{"brackets outside a class are fine", `<script>const x = a-[1]; const y = "w-[2px]"</script>`, ""},
		{"an attribute selector in CSS is fine", `<style>[data-x] { color: red }</style><div class="text-body">`, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := firstArbitraryClass(tt.text); got != tt.want {
				t.Errorf("firstArbitraryClass = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestArbitraryClassCheck(t *testing.T) {
	if !slices.ContainsFunc(pageChecks, func(c pageCheck) bool { return c.warning == WarnArbitraryClass }) {
		t.Fatal("WarnArbitraryClass is not in pageChecks")
	}
	for _, tt := range []struct {
		text string
		want bool
	}{
		{`<div className="min-h-[420px]">`, true},
		{`<script src="/cf/tailwind.js"></script><div className="min-h-[420px]">`, false},
		{`<div className="min-h-112">`, false},
	} {
		if got := arbitraryWithoutRuntime(page{text: tt.text}); got != tt.want {
			t.Errorf("arbitraryWithoutRuntime(%q) = %v, want %v", tt.text, got, tt.want)
		}
	}
}
