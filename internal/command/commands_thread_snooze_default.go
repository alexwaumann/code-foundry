package command

import (
	"context"
)

// thread.snooze.default (docs/notes/put-away-chords.md): cmd+shift+s puts the thread in view
// away to the user's default snooze, one of the snooze menu's presets or save for later (the
// setting threads.default_snooze, which the daemon passes as the default of its to arg,
// Overrides.ArgDefaults). It is thread.snooze given that preset: the same refusals, the same
// confirmation (whatever thread.snooze asks: nowadays nothing,
// docs/notes/snooze-without-teardown.md), the same result. A separate verb, so a bare
// `thread snooze` still says to give until, save or clear.

// SnoozeSave is the default snooze that saves the thread for later (no wake time).
const SnoozeSave = "save"

// SnoozeDefaults are the values of threads.default_snooze and thread.snooze.default's to:
// the snooze menu's presets (gui/frontend/src/lib/snooze.ts snoozePresets, each a form
// parseSnoozeUntil reads the same way) and save.
var SnoozeDefaults = []string{"1h", "3h", "tomorrow", "next-week", SnoozeSave}

// SnoozeDefaultFallback is threads.default_snooze's default: tomorrow at 9:00 AM.
const SnoozeDefaultFallback = "tomorrow"

func threadSnoozeDefault(b ThreadBackend, idArg ArgSpec) Command {
	snooze := threadSnooze(b, idArg)
	// as is thread.snooze's args for this call: the thread and the preset as until, or save.
	as := func(a Args) Args {
		vals := map[string]any{"id": a.String("id")}
		if to := a.String("to"); to == SnoozeSave {
			vals["save"] = true
		} else {
			vals["until"] = to
		}
		return NewArgs(vals)
	}
	cmd := Command{
		Name:  "thread.snooze.default",
		Page:  PageState,
		Title: "Snooze to Default",
		Description: "Snooze a thread to your default snooze (Settings: Default snooze; tomorrow at 9:00 AM unless you change it), " +
			"or save it for later when that is the default. As thread snooze with that time.",
		Category: "Thread",
		// The user's own put-away key; agents give thread snooze a time.
		NoIndex:          true,
		Keybindings:      []string{"cmd+shift+s"},
		KeybindingsYield: true,
		Args: []ArgSpec{
			positional(idArg),
			{Name: "to", Type: Enum, Enum: SnoozeDefaults, Default: SnoozeDefaultFallback,
				Description: "The preset: 1h, 3h, tomorrow (9:00 AM), next-week (Monday 9:00 AM) or save (for later); default: the setting threads.default_snooze"},
		},
		When: hasThread,
		Run: func(ctx context.Context, c Context, a Args) (Result, error) {
			return snooze.Run(ctx, c, as(a))
		},
	}
	if snooze.Confirm != "" {
		cmd.Confirm = snooze.Confirm
		if snooze.ConfirmIf != nil {
			cmd.ConfirmIf = func(ctx context.Context, c Context, a Args) bool { return snooze.ConfirmIf(ctx, c, as(a)) }
		}
		if snooze.DynamicConfirm != nil {
			cmd.DynamicConfirm = func(ctx context.Context, c Context, a Args) string { return snooze.DynamicConfirm(ctx, c, as(a)) }
		}
	}
	return cmd
}
