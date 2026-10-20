package thread

// Branch links (docs/notes/linked-prs-branch.md).
//
// A thread's links also include every pull request whose head is a branch the thread
// works on, in its project's repository. The thread store does not know the GitHub,
// project or workspace stores: the daemon resolves each thread's branches, matches them
// against the GitHub store's cached lists, and pushes the matches here. They are merged
// like Claude's records (deduplicated by URL, a URL the thread has keeps its row, never
// removed) and copied up the CreatedBy chain.

// LinkBranchPullRequests links pull requests found on thread id's branches
// (LinkBranch). Links without a time get now. Returns how many were new to the thread;
// a known URL changes nothing and publishes nothing, and an unknown thread is ignored.
func (m *Manager) LinkBranchPullRequests(id string, links []LinkedPullRequest) int {
	own := make([]LinkedPullRequest, len(links))
	for i, l := range links {
		l.Source, l.ViaThreadID = LinkBranch, ""
		own[i] = l
	}
	return m.linkPullRequests(id, own)
}
