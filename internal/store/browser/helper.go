package browser

// The daemon's own script in each page, in an isolated world: the page's scripts share the DOM
// with it but not its variables, and only this world holds the binding. It exists because
// Chrome's <select> popup is a native menu that never reaches a screencast, and on a Mac the
// arrow keys open that menu too, so a select would be dead. It reads a select's options and
// sets the one the user picks; agents have no way to reach it.
const (
	helperWorld   = "code-foundry-surface"
	helperBinding = "__cfSurface"
	helperPick    = "__cfPick"
)

const helperSource = `(() => {
  if (globalThis.__cfOpen) return;
  let open = null;
  const report = (s) => {
    open = s;
    const r = s.getBoundingClientRect();
    const options = [...s.options].slice(0, 500).map((o) => ({
      label: o.label || o.text,
      disabled: o.disabled || (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
    }));
    globalThis.__cfSurface(JSON.stringify({ t: "select", options, selected: s.selectedIndex, x: r.left, y: r.bottom, w: r.width }));
  };
  const closed = (e) => {
    const t = e.target;
    const s = t instanceof Element ? t.closest("select") : null;
    return s && !s.multiple && s.size <= 1 && !s.disabled ? s : null;
  };
  globalThis.__cfOpen = report;
  addEventListener("mousedown", (e) => {
    const s = closed(e);
    if (!s || !e.isTrusted || e.button !== 0) return;
    e.preventDefault();
    s.focus();
    report(s);
  }, true);
  addEventListener("keydown", (e) => {
    const s = closed(e);
    if (!s || !e.isTrusted || ![" ", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    report(s);
  }, true);
  globalThis.__cfPick = (i) => {
    const s = open;
    open = null;
    if (!s || i < 0 || i >= s.options.length || s.selectedIndex === i) return;
    s.selectedIndex = i;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
  };
})();`
