package ui

import "slices"

// Icons are the lucide icon names (kebab case) the Code Foundry GUI draws in plugin
// views: header and surface icons, glyphs, buttons, notices. Any other well-formed name
// passes Validate and draws a plain circle. Kept in step with the GUI's allowlist
// (gui/frontend/src/components/plugin/icons.ts), sorted.
var Icons = []string{
	"activity", "ban", "bell", "bot", "box", "bug", "calendar", "chart-bar", "check", "circle",
	"circle-alert", "circle-check", "circle-dashed", "circle-slash", "circle-x", "clock", "cloud",
	"code", "container", "copy", "cpu", "database", "download", "external-link", "eye", "file",
	"file-text", "flag", "flask-conical", "folder", "gauge", "git-branch", "git-commit-horizontal",
	"git-merge", "git-pull-request", "globe", "hammer", "heart", "hourglass", "info", "key",
	"key-round", "layers", "link", "list", "loader-circle", "lock", "lock-open", "log-in", "log-out",
	"message-square", "minus", "package", "pause", "pin", "play", "plus", "puzzle", "refresh-cw",
	"rocket", "rotate-ccw", "search", "send", "server", "settings", "shield", "shield-check",
	"sparkles", "square", "star", "terminal", "test-tube", "timer", "trash-2", "triangle-alert",
	"upload", "user", "users", "workflow", "wrench", "x", "zap",
}

// KnownIcon reports whether the GUI draws name (Icons); others draw a circle.
func KnownIcon(name string) bool {
	_, ok := slices.BinarySearch(Icons, name)
	return ok
}
