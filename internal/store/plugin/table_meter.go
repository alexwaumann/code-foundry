package plugin

import "github.com/alexwaumann/code-foundry/pluginsdk/ui"

// A table cell's meter (ui.Meter; docs/notes/plugin-table-meter.md) asks nothing of the
// host beyond the view's validation (ui's Validate: the cell's whole content, a value in
// 0..1, a short label, a known tone): it is drawn, never acted on. The GUI draws it, so the
// host announces it; a host without the capability drops the field when it decodes the
// view, and the cell is empty.
func init() { hostCapabilities = append(hostCapabilities, ui.TableMeterCapability) }
