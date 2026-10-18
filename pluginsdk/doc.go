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
// Every Code Foundry thread has the code-foundry-plugin skill, which documents the
// manifest, the protocol, the view model, the host API, testing and publishing for
// plugin authors (its reference files are written by the daemon at start, beside the
// skill); it and this documentation are all a plugin author needs.
//
// The module needs Go 1.24 or newer and nothing outside the standard library:
//
//	go get github.com/alexwaumann/code-foundry/pluginsdk@<commit>
//
// (or @vX.Y.Z once the module has release tags, which are pluginsdk/vX.Y.Z).
package pluginsdk
