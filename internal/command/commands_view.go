package command

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"time"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
)

// URLOpener opens a URL in the user's browser.
type URLOpener func(ctx context.Context, u string) error

// OpenURL opens u with macOS `open`, which hands http(s) URLs to the default browser.
func OpenURL(ctx context.Context, u string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "/usr/bin/open", u).CombinedOutput(); err != nil {
		return fmt.Errorf("open %s: %w: %s", u, err, out)
	}
	return nil
}

// ViewPullRequests is the ShowView name of the Pull Requests page.
const ViewPullRequests = "pullrequests"

// RegisterView registers the view.* commands: top-level GUI views (emitted as
// UiIntent.ShowView) and opening links. A nil opener uses OpenURL.
func RegisterView(r *Registry, e Emitter, open URLOpener) error {
	if open == nil {
		open = OpenURL
	}
	return r.RegisterAll(
		Command{
			Name:        "view.pullrequests",
			Title:       "Show Pull Requests",
			Description: "Show the Pull Requests page: your open pull requests, reviews requested from you, and recent merges across registered repositories.",
			Category:    "View",
			Keybindings: []string{"cmd+shift+d"},
			Run: func(context.Context, Context, Args) (Result, error) {
				n := e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_ShowView_{ShowView: &v1.UiIntent_ShowView{Name: ViewPullRequests}}})
				// No Message: the GUI toasts non-empty messages, and the page switch is
				// feedback enough. The CLI's --json still reports delivery.
				return Result{JSON: EmitResult{Delivered: n}}, nil
			},
		},
		Command{
			// TODO(phase3 merge): 3c may land pr.open; keep one of the two.
			Name:        "view.open.url",
			Title:       "Open URL in Browser",
			Description: "Open an http(s) link, such as a pull request or a check's log, in the default browser.",
			Category:    "View",
			Args: []ArgSpec{
				{Name: "url", Type: String, Required: true, Description: "http or https URL"},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				raw := a.String("url")
				u, err := url.Parse(raw)
				if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
					return Result{}, &ArgError{Arg: "url", Msg: fmt.Sprintf("%q is not an http(s) URL", raw)}
				}
				if err := open(ctx, u.String()); err != nil {
					return Result{}, err
				}
				return Result{Message: "opened " + u.String()}, nil
			},
		},
	)
}
