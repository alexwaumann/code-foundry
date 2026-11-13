package main

import "github.com/alexwaumann/code-foundry/pluginsdk/ui"

// The demo's menus (docs/notes/plugin-menu.md): the header's ⋯, Build #2's row (three
// buttons the panel folds into its ⋯, then a menu with a one-pick Priority submenu, a URL,
// a copy and a disabled danger item), and the actions bar's More ▾ menu button.

// headerMenu is the header's ⋯ after its two icon actions.
func headerMenu() *ui.Menu {
	return ui.NewMenu(
		ui.EventItem("hdr-reset", "Reset the click count", "reset-clicks", ""),
		ui.EventItem("hdr-form", "Go to the form", "goto-form", ""),
		ui.Separator(),
		ui.URLItem("hdr-sdk", "Open the SDK reference", "https://github.com/alexwaumann/code-foundry/tree/main/pluginsdk"),
	)
}

// runActions are Build #2's buttons: wider together than a narrow pane's row allows
// beside its title, so it folds them into the row's ⋯ (a wide pane shows them).
func runActions() []ui.Button {
	return []ui.Button{
		ui.EventButton("run-2-rerun", "Rerun", "rerun-run").WithData("2").WithIcon("rotate-ccw"),
		ui.EventButton("run-2-log", "Open log", "open-log").WithData("2"),
		ui.CopyButton("run-2-copy-error", "Copy error", "deploy failed: exit status 1"),
	}
}

// runMenu is Build #2's ⋯ and right-click menu, priority the checked one of its Priority
// group.
func runMenu(priority string) *ui.Menu {
	return ui.NewMenu(
		ui.EventItem("run-2-rerun-clean", "Rerun without the cache", "rerun-run", "2"),
		ui.Submenu("run-2-priority", "Priority", ui.PickGroup("priority", "run-2-p-"+priority,
			ui.EventItem("run-2-p-low", "Low", "set-priority", "low"),
			ui.EventItem("run-2-p-normal", "Normal", "set-priority", "normal"),
			ui.EventItem("run-2-p-high", "High", "set-priority", "high"),
		)...),
		ui.Separator(),
		ui.URLItem("run-2-open", "Open in CI", "https://github.com/alexwaumann/code-foundry/actions"),
		ui.CopyItem("run-2-copy-link", "Copy link", "https://github.com/alexwaumann/code-foundry/actions"),
		ui.Separator(),
		ui.EventItem("run-2-delete", "Delete run", "delete-run", "2").AsDanger().AsDisabled(),
	)
}

// barMenuButton is the actions bar's More ▾: a button that opens a menu.
func barMenuButton() ui.Button {
	return ui.Button{Key: "bar-more", Label: "More", Style: ui.ButtonOutline}.WithMenu(ui.NewMenu(
		ui.CopyItem("copy", "Copy greeting", "Hello from the demo surface"),
		ui.EventItem("bar-reset", "Reset the click count", "reset-clicks", ""),
	))
}
