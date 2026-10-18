package pluginsdk

import "regexp"

var actionsURL = regexp.MustCompile(`^https://github\.com/[^/]+/[^/]+/actions/`)

// CheckProvider names who ran a pull request check, as the host's pr.checks.provider
// fact and the pr.checks command report it: the check run's GitHub App slug
// ("github-actions", "buildkite"), else "github-actions" for a details URL under
// https://github.com/<owner>/<repo>/actions/, else "status" (a commit status: Jenkins
// and other external CI).
func CheckProvider(app, url string) string {
	switch {
	case app != "":
		return app
	case actionsURL.MatchString(url):
		return "github-actions"
	}
	return "status"
}
