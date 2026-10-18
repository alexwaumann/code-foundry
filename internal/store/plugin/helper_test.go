package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The test binary doubles as the plugins these tests run (the fakeclaude pattern without
// a separate build): a package's bin/plugin is a script that re-executes it with
// CF_PLUGIN_HELPER set to a mode.

func init() {
	if mode := os.Getenv("CF_PLUGIN_HELPER"); mode != "" {
		os.Exit(helper(mode))
	}
}

func helper(mode string) int {
	switch mode {
	case "crash":
		fmt.Fprintln(os.Stderr, "boom: no config")
		return 3
	case "silent":
		_, _ = io.Copy(io.Discard, os.Stdin)
		return 0
	case "noping":
		return noPing()
	case "ok":
		if err := pluginsdk.Serve(okPlugin()); err != nil {
			fmt.Fprintln(os.Stderr, "serve:", err)
			return 1
		}
		return 0
	}
	fmt.Fprintln(os.Stderr, "unknown helper mode", mode)
	return 2
}

func msg(s string) (pluginsdk.CommandResult, error) { return pluginsdk.CommandResult{Message: s}, nil }

// okPlugin is the well-behaved test plugin.
func okPlugin() pluginsdk.Plugin {
	invoke := func(command string, args map[string]string) pluginsdk.CommandFunc {
		return func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			res, err := h.Invoke(ctx, command, args, req.Context)
			if err != nil {
				return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
			}
			return res, nil
		}
	}
	return pluginsdk.Plugin{
		Init: func(_ context.Context, h *pluginsdk.Host) error {
			h.Log().Info("started", "data", h.DataDir() != "")
			fmt.Println("stray stdout line") // must land in the log, not the protocol
			return nil
		},
		Commands: map[string]pluginsdk.CommandFunc{
			"greet": func(_ context.Context, _ *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return pluginsdk.CommandResult{Message: "hello " + req.Arg("name"), JSON: json.RawMessage(`{"greeted":"` + req.Arg("name") + `"}`)}, nil
			},
			"env": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return msg(os.Getenv(pluginsdk.EnvPlugin) + " " + os.Getenv("CODE_FOUNDRY_TOKEN") + " " + os.Getenv("CF_SECRET_PARENT"))
			},
			"send": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return h.Invoke(ctx, "thread.send", map[string]string{"text": req.Arg("text")}, req.Context)
			},
			"archive": invoke("thread.archive", nil),
			"manage":  invoke("plugin.enable", map[string]string{"name": "x"}),
			"flag": func(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				_ = h.UpdateView("i", map[string]any{"nodes": []any{}})
				err := h.SetFlag(ctx, pluginsdk.Flag{ThreadID: "t", Level: pluginsdk.FlagAttention})
				return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
			},
			"remember": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				if err := h.Secrets().Set(ctx, "word", req.Arg("word")); err != nil {
					return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
				}
				return msg("remembered")
			},
			"recall": func(ctx context.Context, h *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				v, ok, err := h.Secrets().Get(ctx, "word")
				if err != nil {
					return msg(fmt.Sprintf("code %d: %v", pluginsdk.ErrorCode(err), err))
				}
				if !ok {
					return msg("nothing")
				}
				return msg(v)
			},
			"slow": func(ctx context.Context, _ *pluginsdk.Host, _ pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				<-ctx.Done()
				return msg("late")
			},
			"fail": func(context.Context, *pluginsdk.Host, pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
				return pluginsdk.CommandResult{}, errors.New("it broke")
			},
		},
	}
}

// noPing answers initialize, then never answers a ping.
func noPing() int {
	c := pluginsdk.NewConn(os.Stdin, os.Stdout, pluginsdk.ConnOptions{
		Handle: func(ctx context.Context, method string, _ json.RawMessage) (any, error) {
			if method == pluginsdk.MethodInitialize {
				return pluginsdk.InitializeResult{Protocol: 1}, nil
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Hour):
			}
			return nil, nil
		},
	})
	<-c.Done()
	return 0
}
