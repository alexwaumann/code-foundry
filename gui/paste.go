package main

import (
	"fmt"
	"time"
)

const (
	// pasteSettle lets the pasteboard's new contents land before the keys go out.
	pasteSettle = 50 * time.Millisecond
	// pasteRead and pasteRestoreAfter give the app in front time to read the pasteboard
	// before the old contents come back: a paste is handled when the app gets to it.
	pasteRead         = 100 * time.Millisecond
	pasteRestoreAfter = 500 * time.Millisecond
)

// pasteHost is what a paste needs from the system. Calls come from one thread.
type pasteHost interface {
	// Save copies the pasteboard's items in memory. skipped counts the types of them
	// that gave no data and so will not come back.
	Save() (items, skipped int)
	// Write replaces the pasteboard with text, marked transient, and returns its
	// changeCount, which is valid even on an error: the old contents are gone by then.
	Write(text string) (changeCount int64, err error)
	// Post sends Cmd+V. macOS drops the events without a word if it does not allow
	// them, so a nil error says nothing about delivery.
	Post() error
	// Restore puts the saved items back, only if the changeCount is still ours, and
	// says whether it did.
	Restore(changeCount int64) (bool, error)
}

// pasteText pastes text into the app in front through the pasteboard, then gives the
// pasteboard back unless something else wrote to it in the meantime. say reports each
// step; wait is time.Sleep outside tests.
func pasteText(host pasteHost, text string, wait func(time.Duration), say func(string)) error {
	items, skipped := host.Save()
	say(fmt.Sprintf("clipboard saved: %d items, %d types unreadable", items, skipped))
	count, err := host.Write(text)
	if err != nil {
		restorePasteboard(host, count, say)
		return fmt.Errorf("write clipboard: %w", err)
	}
	say(fmt.Sprintf("clipboard written: %q, changeCount %d", text, count))
	wait(pasteSettle)
	if err := host.Post(); err != nil {
		restorePasteboard(host, count, say)
		return fmt.Errorf("post Cmd+V: %w", err)
	}
	say("Cmd+V posted (macOS gives no error if it drops it; check the text field)")
	wait(pasteRead)
	say(fmt.Sprintf("waited %d ms for the app to read it", pasteRead.Milliseconds()))
	wait(pasteRestoreAfter)
	restorePasteboard(host, count, say)
	return nil
}

func restorePasteboard(host pasteHost, count int64, say func(string)) {
	switch restored, err := host.Restore(count); {
	case err != nil:
		say("clipboard not restored: " + err.Error())
	case restored:
		say("clipboard restored")
	default:
		say("clipboard left alone: something else changed it since our write")
	}
}
