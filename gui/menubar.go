package main

import (
	"sync"
	"sync/atomic"
)

// While dictation.anywhere is on the host lives in the menu bar: the hold key has to work
// with no window open, so closing the window hides it, and the Dock icon goes with it,
// instead of quitting. Quit (the menu bar item's, ⌘Q, a relaunch) still ends the process.
// With the setting off nothing here acts: the window closes and the app quits, as ever
// (docs/notes/dictate-anywhere-settings.md).

// menuBarHost is what menuBar asks of AppKit (appMenuBarHost; a fake in tests). A menuBar
// calls it with its lock held and from any goroutine, never from the main thread.
type menuBarHost interface {
	showItem()
	hideItem()
	// conceal hides the window and the Dock icon.
	conceal()
	// reveal brings back the Dock icon, then shows the window in front of other apps.
	reveal()
}

// menuBar decides what closing the window does, from dictation.anywhere. The daemon's
// last word stands while it is away: a restart must not take the item from under a
// hidden window.
type menuBar struct {
	host menuBarHost
	// quitting is apart from mu: shuttingDown runs on the main thread, which a host call
	// holding mu may be waiting on.
	quitting atomic.Bool

	mu       sync.Mutex
	anywhere bool
	hidden   bool
}

// setAnywhere follows dictation.anywhere. Turned off with the window hidden (the CLI, or
// the settings file) the window comes back: nothing else could reach it.
func (m *menuBar) setAnywhere(on bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if on == m.anywhere {
		return
	}
	m.anywhere = on
	if on {
		m.host.showItem()
		return
	}
	m.host.hideItem()
	if m.hidden {
		m.hidden = false
		m.host.reveal()
	}
}

// windowClosing runs before the window closes. It reports whether the window was kept
// (hidden, or to be hidden): the caller cancels the close.
func (m *menuBar) windowClosing() bool {
	if m.quitting.Load() {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.anywhere {
		return false
	}
	if !m.hidden {
		m.hidden = true
		m.host.conceal()
	}
	return true
}

// open is the menu bar item's Open Code Foundry: it also brings a window that is only
// behind other apps to the front.
func (m *menuBar) open() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.hidden = false
	m.host.reveal()
}

// shuttingDown runs when the app starts to quit, whoever asked. Wails then closes every
// window, and those closes must go through.
func (m *menuBar) shuttingDown() {
	m.quitting.Store(true)
}
