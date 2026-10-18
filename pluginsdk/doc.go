// Package pluginsdk is the Go SDK for Code Foundry plugins.
//
// A plugin is a separate executable the daemon starts from the plugin's package
// directory (~/.code-foundry/plugins/<name>, with a plugin.json manifest). The daemon and
// the plugin speak newline-delimited JSON-RPC 2.0 over the plugin's stdin and stdout:
// one JSON object per line, UTF-8, no Content-Length headers. stdout carries the
// protocol only; logs go to stderr or through Host.Log.
//
// The smallest plugin:
//
//	func main() {
//		err := pluginsdk.Serve(pluginsdk.Plugin{
//			Commands: map[string]pluginsdk.CommandFunc{
//				"greet": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
//					return pluginsdk.CommandResult{Message: "hello"}, nil
//				},
//			},
//		})
//		if err != nil {
//			log.Fatal(err)
//		}
//	}
//
// with a manifest declaring the command:
//
//	{"name": "hello", "version": "0.1.0", "protocol": 1, "exec": ["bin/hello"],
//	 "commands": [{"name": "greet", "title": "Greet"}]}
//
// The package has no dependencies outside the standard library, so a plugin repository
// imports it without the daemon's dependency graph. Subpackages: ui (typed builders for
// the surface view model) and plugintest (a fake host for unit tests).
//
// The protocol (methods, errors, versioning) is described in the Code Foundry repository
// under docs/sketches/plugins/ARCHITECTURE.md §B; the manifest in §A.1.
package pluginsdk
