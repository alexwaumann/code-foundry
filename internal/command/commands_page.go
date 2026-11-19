package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	pagestore "github.com/alexwaumann/code-foundry/internal/store/page"
)

// page.get, page.allow and page.disallow: who owns an HTML page and the user's answer for
// a page no thread owns (docs/notes/page-ownership-daemon.md). The GUI asks once when the
// user opens a page no thread owns and runs page.allow or page.disallow with the answer;
// the same verbs change it later. A page's own script may not run them: the answer is the
// user's about that script. The agent guide leaves them out (NoIndex): the answers are the
// user's, not an agent's work; `help page.get` still has them.

// PageBackend is the page store as the page.* commands use it; *pagestore.Store implements it.
type PageBackend interface {
	Access(ctx context.Context, path string) (pagestore.Access, error)
	SetConsent(ctx context.Context, path string, allowed bool) (pagestore.Access, error)
}

var _ PageBackend = (*pagestore.Store)(nil)

const pageCategory = "Pages"

// PageView is the page.* commands' JSON. OwnerThread is the page's first owner (its
// default thread; docs/notes/page-storage-per-file.md) and Owners every owner, first
// first; a source is "shown", "written", "pages-directory" or "" (no owner); Consent is
// "owned", "allowed", "refused" or "not-asked" (whether the page may use the bridge);
// Answer is the user's own answer, "allowed", "refused" or "not-asked", kept while a
// thread owns the page.
type PageView struct {
	Path        string          `json:"path"`
	OwnerThread string          `json:"owner_thread"`
	OwnerSource string          `json:"owner_source"`
	Owners      []PageOwnerView `json:"owners"`
	Consent     string          `json:"consent"`
	Answer      string          `json:"answer"`
}

// PageOwnerView is one owner of a page in PageView.
type PageOwnerView struct {
	Thread string `json:"thread"`
	Source string `json:"source"`
}

func pageView(a pagestore.Access) PageView {
	v := PageView{Path: a.Path, OwnerThread: a.Owner, OwnerSource: a.How(), Owners: []PageOwnerView{}, Answer: consentWord(a.Consent)}
	for _, o := range a.Owners {
		v.Owners = append(v.Owners, PageOwnerView{Thread: o.Thread, Source: o.How})
	}
	v.Consent = v.Answer
	if a.Owner != "" {
		v.Consent = "owned"
	}
	return v
}

// ownerWhy says how a thread owns a page.
func ownerWhy(how string) string {
	switch how {
	case pagestore.Written:
		return "it wrote the page"
	case pagestore.PagesDirectory:
		return "its pages directory"
	}
	return "it showed the page"
}

func consentWord(c pagestore.Consent) string {
	return strings.ReplaceAll(c.String(), " ", "-")
}

// pageMessage is a page's state as a line or two.
func pageMessage(a pagestore.Access) string {
	var b strings.Builder
	b.WriteString(a.Path + "\n")
	switch len(a.Owners) {
	case 0:
		b.WriteString("owner: none")
	case 1:
		fmt.Fprintf(&b, "owner: thread %s (%s): the page gets its bridge", a.Owner, ownerWhy(a.Owners[0].How))
	default:
		whys := make([]string, len(a.Owners))
		for i, o := range a.Owners {
			whys[i] = fmt.Sprintf("thread %s (%s)", o.Thread, ownerWhy(o.How))
		}
		fmt.Fprintf(&b, "owners: %s: a view of one of them acts for that thread, any other for %s", strings.Join(whys, ", "), a.Owner)
	}
	b.WriteString("\n")
	switch a.Consent {
	case pagestore.Allowed:
		b.WriteString("answer: allowed")
	case pagestore.Refused:
		b.WriteString("answer: not allowed")
	default:
		b.WriteString("answer: not asked")
	}
	if a.Owner != "" && a.Consent != pagestore.NotAsked {
		b.WriteString(" (counts once no thread owns the page)")
	} else if a.Owner == "" {
		if a.Consent == pagestore.Allowed {
			b.WriteString(": the page gets the bridge without a thread")
		} else {
			b.WriteString(": the page gets no bridge")
		}
	}
	return b.String()
}

// RegisterPage registers page.get, page.allow and page.disallow. A nil backend registers
// them failing with Unimplemented.
func RegisterPage(r *Registry, b PageBackend) error {
	pathArg := ArgSpec{Name: "path", Type: Path, Required: true, Positional: true,
		Description: "The page: an .html or .htm file under the home directory (absolute, ~/…, or relative to the current directory)"}
	run := func(fn func(ctx context.Context, path string) (pagestore.Access, error)) func(context.Context, Context, Args) (Result, error) {
		return func(ctx context.Context, _ Context, a Args) (Result, error) {
			if b == nil {
				return Result{}, errNoPages
			}
			acc, err := fn(ctx, a.Path("path"))
			if err != nil {
				return Result{}, pageErr(err)
			}
			return Result{Message: pageMessage(acc), JSON: pageView(acc)}, nil
		}
	}
	answer := func(allowed bool) func(context.Context, Context, Args) (Result, error) {
		inner := run(func(ctx context.Context, path string) (pagestore.Access, error) {
			return b.SetConsent(ctx, path, allowed)
		})
		return func(ctx context.Context, uctx Context, a Args) (Result, error) {
			// A page, or a caller that did not say who it is (an older GUI's page).
			if uctx.Untrusted() {
				return Result{}, connect.NewError(connect.CodePermissionDenied,
					errors.New("only the user answers for pages, in the app or with the CLI: a page, or a caller that does not say it is one of those, cannot"))
			}
			return inner(ctx, uctx, a)
		}
	}
	return r.RegisterAll(
		Command{
			Name:      "page.get",
			Page:      PageState,
			NoPalette: true,
			NoIndex:   true,
			ReadOnly:  true,
			Title:     "Show Page Owner",
			Description: "Show which threads own an HTML page (each that showed or wrote it, and the thread whose pages directory " +
				"holds it) and the user's answer for it: a page a thread owns gets a thread's bridge, any other the bridge without " +
				"a thread once the user allows it.",
			Category:     pageCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{pathArg},
			Run:          run(func(ctx context.Context, path string) (pagestore.Access, error) { return b.Access(ctx, path) }),
		},
		Command{
			Name:      "page.allow",
			Page:      PageState,
			NoPalette: true,
			NoIndex:   true,
			Title:     "Allow Page",
			Description: "Allow an HTML page no thread owns to use Code Foundry (cf.storage, cf.fetch and the app-wide " +
				"commands of the bridge, without a thread). Kept for the file, whatever its content; not for a page's own script.",
			Category:     pageCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{pathArg},
			Run:          answer(true),
		},
		Command{
			Name:      "page.disallow",
			Page:      PageState,
			NoPalette: true,
			NoIndex:   true,
			Title:     "Stop Allowing Page",
			Description: "Do not let an HTML page no thread owns use Code Foundry: it shows without the bridge and is not " +
				"asked about again. Kept for the file, whatever its content; not for a page's own script.",
			Category:     pageCategory,
			NoKeybinding: true,
			Args:         []ArgSpec{pathArg},
			Run:          answer(false),
		},
	)
}

var errNoPages = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon keeps no pages' owners"))

// pageErr is a page store error as the commands return it.
func pageErr(err error) error {
	switch {
	case errors.Is(err, pagestore.ErrInvalidArgument):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, pagestore.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, pagestore.ErrGuarded):
		return connect.NewError(connect.CodePermissionDenied, err)
	}
	return err
}
