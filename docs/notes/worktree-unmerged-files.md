# Worktree detail: conflicted files are U

A daemon fix. `WorktreeDetail.Files` lists uncommitted changes with
`git diff --name-status HEAD`, which compares HEAD with the working tree and never looks
at index stages. During a rebase or merge stopped on conflicts, a conflicted path
therefore came out as `M`. The worktree panel (PR #133) sorts `U` first and tags it
"conflict", but live it never saw a `U`.

## Fix: the paths come from the status job (no extra git process)

The status job already runs `git status --porcelain=v2 --branch -z`, whose `u` records
are the unmerged paths; it only counted them (`Status.Conflicted`).

- `parseStatusV2` keeps them in `statusInfo.Unmerged`, in output order. A `u` record has
  ten space-separated fields before the path, so it splits into at most 11 and the path
  may contain spaces. A `u` record without a path is a parse error, like a short `1`
  record. They are not on `Status`, which is published and compared with `==`.
- The status job stores them in `wtSlot.unmerged` (`atomic.Pointer[[]string]`, written
  only by the status job, like `wtSlot.base`). Only a successful refresh writes it, so a
  failed one keeps the last list, as it keeps the rest of `Status`.
- The detail job (`detail`) loads it next to `slot.cur` and passes it to `fillDetail`. In
  the non-clean branch the paths are appended to the uncommitted name-status list as
  `U` entries, after the diff's own entries. `mergeFiles` keys by path, so a conflicted
  path is still one `FileChange`; the later `U` replaces the diff's `M`, and the numstat
  counts are looked up by path as before. `mergeFiles` itself is unchanged: same
  sort by path, same cap. The GUI sorts `U` first itself.
- A conflict makes `Status.Dirty` true, so the clean shortcut (tree-to-tree diff, cached
  in the head part) never applies while there are conflicts. No cache key changes.
- A path git reports as unmerged but the diff does not list (for example a deleted-by-both
  conflict whose file is gone) still shows up, as `U` with no counts.

The fallback (`git ls-files --unmerged -z` inside the detail job when `Conflicted > 0`)
was not needed: the plumbing is one slot field and one parameter. The common case and the
conflict case run exactly the same git commands as before.

## Tests

- `TestParseStatusV2`: the existing merge conflict fixture now expects its path; a
  captured rebase with two conflicts (one path with a space) next to a staged change; a
  deleted-by-them (`UD`) record; a `u` record without a path is an error. The test
  compares with `reflect.DeepEqual`, since `statusInfo` now holds a slice.
- `TestMergeFiles`: a path arriving as `M` and then `U` is one `U` entry with its counts,
  and an unmerged path the diff did not list is added; order is unchanged.
- `TestWorktreeDetailConflicts`: real git. A rebase in a linked worktree stops on a
  README conflict: README is `U` with its counts, and the cleanly applied `g.txt` of the
  same pick stays `A`. After `--abort`, README is back to `M` and nothing is `U`.

## End to end

2026-10-16, with a fresh `make build`. The setup follows `worktree-op-state.md`: HOME is
inside `/tmp` (`HomeRoot` is `$HOME`), CODE_FOUNDRY_HOME is isolated, and the RPCs go
through `buf curl` over the daemon socket.

```sh
E=/tmp/cf-unmerged; mkdir -p $E/home $E/cfhome      # + $E/home/.gitconfig with user.name/email
export HOME=$E/home CODE_FOUNDRY_HOME=$E/cfhome
R=$HOME/scratch; git init -q $R && cd $R
echo base > a.txt && echo base > 'b c.txt' && git add . && git commit -qm base
git checkout -qb feature
echo feature > a.txt && echo feature > 'b c.txt' && echo new > clean.txt && git add . && git commit -qm "feature 1"
echo 2 > f2.txt && git add . && git commit -qm "feature 2"
git checkout -q main && echo main > a.txt && echo main > 'b c.txt' && git commit -qam "main change"

./bin/code-foundry daemon --dev > $E/daemon.log 2>&1 &
./bin/code-foundry repo add $R && git -C $R checkout -q feature   # registered on main: default branch main

rpc() { ~/go/bin/buf curl --protocol connect --http2-prior-knowledge --unix-socket $E/cfhome/daemon.sock \
  --schema proto -d "$2" "http://localhost/codefoundry.v1.RepoService/$1"; }
ID=$(rpc List '{}' | jq -r '.repos[0].id'); WT=$(rpc List '{}' | jq -r '.repos[0].worktrees[0].path')
detail() { rpc GetWorktreeDetail "{\"repoId\":\"$ID\",\"path\":\"$WT\"}" \
  | jq -c '[.detail.files[] | {path, status, added, deleted, uncommitted}]'; }

detail
git -C $R rebase main; sleep 1.5; detail          # stops on "feature 1"
git -C $R rebase --abort; sleep 1.5; detail
```

The daemon was not restarted between steps (status flags trimmed, nulls dropped):

```
before:  a.txt M +1-1, b c.txt M +1-1, clean.txt A, f2.txt A        (committed)
rebase:  {"conflicted":2,"operation":"rebase","operationStep":1,"operationTotal":2}
         a.txt U +4 uncommitted, b c.txt U +4 uncommitted, clean.txt A uncommitted
abort:   a.txt M +1-1, b c.txt M +1-1, clean.txt A, f2.txt A        (back as before)
```

Each conflicted path appears once, a path with a space works, and the cleanly applied
`clean.txt` of the same pick stays `A`. The daemon's debug line for the recompute during
the conflict is `clean=false git_runs=7`, the same commands any dirty worktree's detail
runs (four for the head part, then the uncommitted diff, ls-files and numstat); the clean
recomputes before and after are `git_runs=5`, as on main.

## Gotchas

- Without an origin, the default branch is the main checkout's current branch as of the
  last reconcile (`defaultBranch`, by design). In the first run the scratch repo was
  registered on `feature`, so it had no base and the list was empty except during the
  rebase. Registering on `main` gives the comparison above. This is existing behavior
  and is not changed here.
- This worktree's sandbox refuses inline shell that runs git outside the checkout, so the
  e2e ran from a script file under `/tmp`.
