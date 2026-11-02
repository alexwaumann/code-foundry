package main

// The extra mouse buttons step the window's selection history like a browser's: the
// rear side button (button 4) is Back and the front one (button 5) is Forward. WebKit on
// macOS reports every button past the third as the middle button, so the page cannot
// tell them apart; the host watches for them natively (mousebuttons_darwin.go) and asks
// the page to run the command, as the app menu does (EventRunCommand). They run
// view.back and view.forward, so the mouse adds no user action of its own.

// mouseButtonCommands maps an NSEvent buttonNumber (0 left, 1 right, 2 middle; 3 and 4
// are the side buttons a mouse calls 4 and 5) to the command it runs.
var mouseButtonCommands = map[int]string{
	3: "view.back",
	4: "view.forward",
}

// mouseButtonCommand returns the command an extra mouse button runs, and whether it has one.
func mouseButtonCommand(buttonNumber int) (string, bool) {
	c, ok := mouseButtonCommands[buttonNumber]
	return c, ok
}
