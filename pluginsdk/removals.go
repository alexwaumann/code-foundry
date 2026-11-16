package pluginsdk

import (
	"fmt"
	"log/slog"
	"slices"
	"sync"
)

// The removal list: every SDK call, method or field on its way out, with what replaces
// it and when it moved. An entry goes through three stages:
//
//   - deprecated: it still works (the host may serve it another way). Its Go symbols
//     carry a "Deprecated:" comment naming the replacement, and the host logs, once per
//     plugin run, that the plugin called it.
//   - retired: the function keeps its exact signature but does nothing: it logs a warning
//     naming the replacement in the plugin's log (once per process per symbol, Retired)
//     and returns zero values. The host answers its protocol method without acting and
//     logs that once per plugin, so an old plugin binary neither breaks nor silently
//     seems to work.
//   - deleted: gone from the code and from this list, only ever when the user asks (the
//     dates are there for "delete everything retired more than two months ago").
//
// `code-foundry plugin removals` prints the list; the plugin skill's removals reference
// is rendered from it.

// Stage is where a removal is.
type Stage string

// Removal stages (deleted entries are not in the list).
const (
	StageDeprecated Stage = "deprecated"
	StageRetired    Stage = "retired"
)

// Removal is one SDK call on its way out.
type Removal struct {
	// Symbols are the Go symbols it covers, the call a plugin makes first ("Host.SetFlag",
	// then its types, constants and fields). A symbol of a sub-package is qualified by
	// the package ("plugintest.Options.Flags"). Each carries a "Deprecated:" comment.
	Symbols []string `json:"symbols"`
	// Method is the protocol method it calls, "" for none.
	Method string `json:"method,omitempty"`
	// Replacement is what to call instead.
	Replacement string `json:"replacement"`
	// Hint is the move in one line.
	Hint  string `json:"hint"`
	Stage Stage  `json:"stage"`
	// Deprecated is the day it was deprecated, Retired the day it was retired ("" until
	// then), both YYYY-MM-DD.
	Deprecated string `json:"deprecated"`
	Retired    string `json:"retired,omitempty"`
}

// Symbol is the call a plugin makes, the entry's first symbol.
func (r Removal) Symbol() string {
	if len(r.Symbols) == 0 {
		return ""
	}
	return r.Symbols[0]
}

// Since is the day it entered its current stage.
func (r Removal) Since() string {
	if r.Stage == StageRetired {
		return r.Retired
	}
	return r.Deprecated
}

// Removals is the list, oldest first.
var Removals = []Removal{
	{
		Symbols: []string{
			"Host.SetFlag", "Host.Flags", "Flag", "FlagResult", "FlagAttention", "FlagError", "FlagNone",
			"MethodThreadSetFlag", "InitializeParams.Flags", "plugintest.Options.Flags", "plugintest.Host.Flags",
		},
		Method:      MethodThreadSetFlag,
		Replacement: "Host.Notify",
		Hint: "post a notification naming the thread (ThreadID) under a key of your own, level warning or error; " +
			"WithdrawNotification(key) when the condition ends; never post again what the user dismissed",
		Stage:      StageDeprecated,
		Deprecated: "2026-11-16",
	},
}

// RemovalOf returns the entry covering symbol.
func RemovalOf(symbol string) (Removal, bool) {
	i := slices.IndexFunc(Removals, func(r Removal) bool { return slices.Contains(r.Symbols, symbol) })
	if i < 0 {
		return Removal{}, false
	}
	return Removals[i], true
}

// RemovalOfMethod returns the entry of a protocol method.
func RemovalOfMethod(method string) (Removal, bool) {
	i := slices.IndexFunc(Removals, func(r Removal) bool { return r.Method != "" && r.Method == method })
	if i < 0 {
		return Removal{}, false
	}
	return Removals[i], true
}

// Notice is what a log says when a plugin uses the entry: what, since when, what instead.
func (r Removal) Notice() string {
	what := r.Symbol()
	if r.Method != "" {
		what += " (" + r.Method + ")"
	}
	switch r.Stage {
	case StageRetired:
		return fmt.Sprintf("%s was retired on %s and does nothing: use %s (%s)", what, r.Retired, r.Replacement, r.Hint)
	default:
		return fmt.Sprintf("%s is deprecated since %s and will stop working: use %s (%s)", what, r.Deprecated, r.Replacement, r.Hint)
	}
}

// retiredWarned are the symbols Retired has logged in this process.
var retiredWarned sync.Map

// Retired is what a retired function does before returning its zero values: it logs
// once per process per symbol, at warning level, that the call did nothing and what
// replaces it. log is the plugin's log (Host.Log); nil uses slog.Default.
func Retired(log *slog.Logger, symbol string) {
	if _, warned := retiredWarned.LoadOrStore(symbol, true); warned {
		return
	}
	if log == nil {
		log = slog.Default()
	}
	r, ok := RemovalOf(symbol)
	if !ok {
		log.Warn(symbol + " was retired and does nothing")
		return
	}
	log.Warn(r.Notice(), "symbol", symbol, "replacement", r.Replacement)
}
