package ui

import "slices"

// Icons are the lucide icon names (kebab case) the Code Foundry GUI draws in plugin
// views: header and surface icons, glyphs, buttons, notices. Any other well-formed name
// passes Validate and draws a plain circle. Kept in step with the GUI's allowlist
// (gui/frontend/src/components/plugin/icons.ts), sorted.
var Icons = []string{
	"activity", "alarm-clock", "alarm-clock-off", "archive", "arrow-down", "arrow-down-to-line",
	"arrow-down-up", "arrow-left", "arrow-right", "arrow-right-left", "arrow-up", "ban", "bell",
	"bell-ring", "bookmark", "bot", "box", "brain-circuit", "broom", "bug", "building-complex",
	"calendar", "chart-bar", "chart-column", "check", "chevron-down", "chevron-left",
	"chevron-right", "chevron-up", "circle", "circle-alert", "circle-arrow-up", "circle-check",
	"circle-dashed", "circle-dot", "circle-question-mark", "circle-slash", "circle-stop",
	"circle-x", "clipboard-check", "clock", "cloud", "cloud-download", "cloud-upload", "code",
	"command", "container", "copy", "corner-down-left", "corner-down-right", "corner-left-up",
	"cpu", "database", "download", "ellipsis", "external-link", "eye", "eye-off", "file",
	"file-archive", "file-braces", "file-code", "file-code-corner", "file-diff", "file-image",
	"file-pen", "file-plus", "file-question-mark", "file-terminal", "file-text", "file-x", "flag",
	"flask-conical", "fold-vertical", "folder", "folder-git-2", "folder-open", "folder-plus",
	"folder-root", "folders", "gauge", "git-branch", "git-branch-plus", "git-commit-horizontal",
	"git-compare", "git-compare-arrows", "git-merge", "git-merge-conflict", "git-pull-request",
	"git-pull-request-closed", "git-pull-request-draft", "globe", "hammer", "heart", "hourglass",
	"house", "image", "image-plus", "info", "key", "key-round", "keyboard", "layers", "lightbulb",
	"link", "link-2", "list", "list-checks", "list-todo", "loader-circle", "lock", "lock-open",
	"log-in", "log-out", "logs", "map-pin", "maximize-2", "message-circle",
	"message-circle-question-mark", "message-square", "message-square-text", "messages-square",
	"mic", "minimize-2", "minus", "monitor", "moon", "octagon-x", "package", "palette",
	"panel-bottom", "panel-right", "paperclip", "pause", "pencil", "pin", "play", "plug", "plus",
	"power", "power-off", "puzzle", "quote", "refresh-cw", "rocket", "rotate-ccw",
	"rotate-ccw-clock", "rotate-cw", "search", "search-x", "send", "server", "settings",
	"settings-2", "shield", "shield-alert", "shield-check", "shield-question-mark",
	"sliders-horizontal", "sparkle", "sparkles", "split", "square", "square-arrow-out-up-right",
	"square-chart-gantt", "square-chevron-right", "square-kanban", "square-terminal", "star",
	"sun", "terminal", "test-tube", "text-wrap", "timer", "trash", "trash-2", "triangle-alert",
	"undo-2", "unlink", "unplug", "upload", "user", "user-x", "users", "wand-sparkles",
	"workflow", "wrench", "x", "zap",
}

// KnownIcon reports whether the GUI draws name (Icons); others draw a circle.
func KnownIcon(name string) bool {
	_, ok := slices.BinarySearch(Icons, name)
	return ok
}
