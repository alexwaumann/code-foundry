package command

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

const uiHead = `<link rel="stylesheet" href="/cf/theme.css"><link rel="stylesheet" href="/cf/ui.css">`

func TestUnknownClasses(t *testing.T) {
	tests := []struct {
		name, text string
		want       []string
	}{
		// Thread 1 of the pages trial: a Done step was meant to be struck through.
		{"a ternary's class, not its compared value", uiHead +
			`<span className={step.status === "done" ? "line-through" : ""}>`, []string{"line-through"}},
		{"a quoted attribute", uiHead + `<div class="flex font-mono gap-2">`, []string{"font-mono"}},
		{"cn's strings, not another call's", uiHead +
			`<div className={cn("p-2", x && "whitespace-pre", label("not-a-class"), tones["ok"])}>`, []string{"whitespace-pre"}},
		{"a template's text and its ${…}", uiHead + "<div className={`list-disc ${open ? \"capitalize\" : \"\"} p-2`}>",
			[]string{"list-disc", "capitalize"}},
		{"a grouping keeps its context", uiHead + `<div className={"p-2 " + (x ? "w-1/2" : "w-full")}>`, []string{"w-1/2"}},
		{"what ui.css has is fine", uiHead +
			`<div className="flex items-center gap-1.5 text-body-sm text-cf-text-muted hover:bg-cf-surface-raised size-3.5 sm:grid-cols-2">`, nil},
		// Thread 2 of the trial wrote its own rules: they are the page's.
		{"the page's own <style>", uiHead + `<style>.row:hover{background:var(--cf-surface-raised)}.muted{color:var(--cf-text-muted)}</style>` +
			`<div className="row muted p-2">`, nil},
		{"a hook found by selector or by name", uiHead +
			`<div class="js-card"></div><b class="mark"></b><script>document.querySelector(".js-card"); document.getElementsByClassName("mark")</script>`, nil},
		{"an arbitrary value is the other check's", uiHead + `<div className="min-h-[420px]">`, nil},
		{"interpolations are not classes", uiHead + "<div class=\"p-2 ${cls} ${a ? b : c}\">", nil},
		{"no ui.css: the page paints itself", `<link rel="stylesheet" href="/cf/theme.css"><div class="line-through">`, nil},
		{"the runtime makes any utility", uiHead + `<script src="/cf/tailwind.js"></script><div class="line-through">`, nil},
		{"each class once, in order", uiHead + `<i class="lowercase"></i><b class="line-through lowercase"></b>`, []string{"lowercase", "line-through"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := unknownClasses(page{text: tt.text}); !slices.Equal(got, tt.want) {
				t.Errorf("unknownClasses = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestUnknownClassesCapped(t *testing.T) {
	var b strings.Builder
	b.WriteString(uiHead + `<div class="`)
	for i := range unknownClassMax + 3 {
		fmt.Fprintf(&b, "nope-%d ", i)
	}
	b.WriteString(`">`)
	got := unknownClasses(page{text: b.String()})
	if len(got) != unknownClassMax+1 || got[unknownClassMax] != "…" {
		t.Errorf("unknownClasses = %q, want %d names and …", got, unknownClassMax)
	}
}

func TestUnknownClassWarning(t *testing.T) {
	i := slices.IndexFunc(pageListChecks, func(c pageListCheck) bool { return c.warning == WarnUnknownClass })
	if i < 0 {
		t.Fatal("WarnUnknownClass is not in pageListChecks")
	}
	if got := fmt.Sprintf(pageListChecks[i].warning, "line-through"); !strings.Contains(got, "do nothing: line-through. ") {
		t.Errorf("warning %q", got)
	}
}

func TestPollsCfRun(t *testing.T) {
	tests := []struct {
		name, text string
		want       bool
	}{
		{"a named callback that calls cf.run", `async function load() { await cf.run("thread.list") } setInterval(load, 5000)`, true},
		{"an inline callback", `setInterval(async () => { draw(await cf.run("pr.checks", {number: 4})) }, 3000)`, true},
		{"a callback calling a function that does", `const load = async () => { s = await cf.run("usage.show") }; setInterval(() => { load() }, 60000)`, true},
		{"useCallback", `const refresh = useCallback(async () => { set(await cf.run("thread.list")) }, []); useEffect(() => { const i = setInterval(refresh, 9000); return () => clearInterval(i) }, [])`, true},
		{"a setTimeout loop", `function poll() { cf.run("pr.checks", {number: 4}).then(draw); setTimeout(poll, 5000) }`, true},
		// Thread 2 of the pages trial: a ticker for "5m ago" labels in a page that archives from a click.
		{"a label ticker", `async function archive(id) { await cf.run("thread.archive", {id}) }
useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(i); }, []); // only "5m ago"`, false},
		{"a clock", `cf.on("thread-list", draw); btn.onclick = () => cf.run("thread.pin", {id}); setInterval(() => { clock.textContent = new Date().toLocaleTimeString() }, 1000)`, false},
		{"a cf.fetch refresh", `async function load() { const r = await cf.fetch(url); show(r.json()) } btn.onclick = () => cf.run("thread.pin", {id}); setInterval(load, 60000)`, false},
		{"an expression arrow stops at its statement", `const now = () => setNow(Date.now());
async function act() { await cf.run("thread.pin", {id}) }
setInterval(now, 1000)`, false},
		{"a flash message", `btn.onclick = () => cf.run("thread.pin", {id}).then(() => { msg.hidden = false; setTimeout(() => { msg.hidden = true }, 2000) })`, false},
		{"no cf.run at all", `setInterval(() => cf.fetch(url), 1000)`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pollsCfRun(tt.text); got != tt.want {
				t.Errorf("pollsCfRun = %v, want %v", got, tt.want)
			}
		})
	}
}
