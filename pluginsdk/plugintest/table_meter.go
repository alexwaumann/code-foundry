package plugintest

import "github.com/alexwaumann/code-foundry/pluginsdk/ui"

// The host draws a table cell's meter (ui.Meter); a test reads one with TableCell.
func init() { HostCapabilities = append(HostCapabilities, ui.TableMeterCapability) }
