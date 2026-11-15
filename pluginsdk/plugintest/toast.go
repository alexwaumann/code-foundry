package plugintest

import "github.com/alexwaumann/code-foundry/pluginsdk"

// The host knows the success level and a toast's description; Toasts records both.
func init() {
	HostCapabilities = append(HostCapabilities, pluginsdk.ToastDescriptionCapability)
}
