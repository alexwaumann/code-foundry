#!/usr/bin/env python3
"""Run the guide eval: the task set against one build, model and effort. See README.md.

Each round gets its own scratch home, daemon and project with a local bare origin, all
under one ~/.cf-guide-eval-* folder, which goes at the end, on failure too. Results go to
--out, outside the repo.

Nothing here may reach the real ~/.code-foundry: `bin/code-foundry` auto-starts a daemon
on any call, even `help`, so every call goes through Home.cf with the scratch home set and
any CODE_FOUNDRY_* inherited from an enclosing thread removed.
"""
import argparse
import concurrent.futures
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import score

HERE = Path(__file__).resolve().parent
MODELS = {"opus": "claude-opus-5-5[1m]", "sonnet": "claude-sonnet-5-5[1m]"}
OTHER_MODEL = {"opus": "Sonnet 5.5", "sonnet": "Opus 5.5"}
ROOT_PREFIX = ".cf-guide-eval-"
THREAD_BUDGET = "4.00"  # per thread, in USD: the daemon interrupts Claude at it
WORKER_MODEL, WORKER_EFFORT = MODELS["sonnet"], "low"  # the workers of a home task: its brief is what is tested
SETTLE_POLLS, POLL_SECONDS = 3, 10  # a run is over after this many quiet polls in a row
# p5 searches for this thread. Its home is the one the task runs in; were it to land in
# Claude's memory files, p5 would answer from them and never search (run_round removes them).
SEED_PROMPT = ("We decided how a --shout flag for this CLI should behave: it upper-cases the whole greeting, the name "
               "too, and adds no exclamation mark. Nothing to do now, and do not save this anywhere. Reply with one word: noted.")

# What a shell or make run leaves in the environment that must not reach a scratch daemon.
SCRUB_NAMES = {"CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_AGENT_SDK_VERSION", "MAKEFLAGS", "MFLAGS",
               "MAKELEVEL", "PKG_CONFIG_PATH", "MACOSX_DEPLOYMENT_TARGET", "CGO_CFLAGS", "CGO_LDFLAGS"}
SCRUB_PREFIXES = ("CODE_FOUNDRY_", "CLAUDE_CODE_", "GIT_")

# A local bare origin means no write can reach GitHub through git. This keeps gh read-only
# too: a thread (or the daemon for it) gets only the subcommands below.
GH_GUARD = r"""#!/bin/bash
# guide-eval: gh, read-only.
real=%(real)s
refuse() { echo "$*" >>%(log)s; echo "gh: refused by the guide eval (read-only)" >&2; exit 1; }
case "$1 $2" in
  "auth token"*|"auth status"*|"pr view"|"pr list"|"pr checks"|"pr status"|"pr diff"|"repo view"|"repo list"|\
  "issue view"|"issue list"|"run view"|"run list"|"release view"|"release list"|"search "*|"--version "*|"version "*) ;;
  "api "*)
    for a in "$@"; do
      case "$a" in -X|--method|-XPOST|-XPUT|-XPATCH|-XDELETE|--input|-f|-F|--field|--raw-field|graphql) refuse "$@" ;; esac
    done ;;
  *) refuse "$@" ;;
esac
exec "$real" "$@"
"""

# Records every claude spawn's argv (NUL separated): the exact system prompt and flags.
CLAUDE_RECORDER = """#!/bin/bash
printf '%%s\\0' "$@" >%(dir)s/$$
exec %(real)s "$@"
"""

FIXTURE = {
    "go.mod": "module example.com/greet\n\ngo 1.24\n",
    "main.go": 'package main\n\nimport (\n\t"flag"\n\t"fmt"\n)\n\nfunc main() {\n\tname := flag.String("name", "world", '
               '"who to greet")\n\tflag.Parse()\n\tfmt.Println(Greeting(*name))\n}\n',
    "greet.go": 'package main\n\nimport "fmt"\n\n// Greeting is the line greet prints.\nfunc Greeting(name string) string '
                '{\n\treturn fmt.Sprintf("Hello, %s", name)\n}\n',
    "greet_test.go": 'package main\n\nimport "testing"\n\nfunc TestGreeting(t *testing.T) {\n\tif got := Greeting("Ada"); '
                     'got != "Hello, Ada" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n',
    "README.md": "# greet\n\nA small CLI that greets someone: `go run . --name Ada`.\n",
}


# A home task's project. The switch has three spots for four new cases, and the usage line, the
# README's list and the changelog are one spot each: briefs that name no owner or anchor conflict.
OVERLAP_FIXTURE = {
    "go.mod": FIXTURE["go.mod"],
    "main.go": 'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nconst usage = "usage: greet <hello|bye> [name]"\n\n'
               'func main() {\n\tif len(os.Args) < 2 {\n\t\tfmt.Fprintln(os.Stderr, usage)\n\t\tos.Exit(2)\n\t}\n'
               '\tname := "world"\n\tif len(os.Args) > 2 {\n\t\tname = os.Args[2]\n\t}\n\tswitch os.Args[1] {\n'
               '\tcase "hello":\n\t\tfmt.Println(Greeting(name))\n\tcase "bye":\n\t\tfmt.Println(Farewell(name))\n'
               '\tdefault:\n\t\tfmt.Fprintln(os.Stderr, usage)\n\t\tos.Exit(2)\n\t}\n}\n',
    "greet.go": 'package main\n\nimport "fmt"\n\n// Greeting is the line greet hello prints.\nfunc Greeting(name string) string '
                '{\n\treturn fmt.Sprintf("Hello, %s", name)\n}\n\n// Farewell is the line greet bye prints.\n'
                'func Farewell(name string) string {\n\treturn fmt.Sprintf("Bye, %s", name)\n}\n',
    "greet_test.go": 'package main\n\nimport "testing"\n\nfunc TestGreeting(t *testing.T) {\n\tif got := Greeting("Ada"); '
                     'got != "Hello, Ada" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n\nfunc TestFarewell(t *testing.T) {\n'
                     '\tif got := Farewell("Ada"); got != "Bye, Ada" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n',
    "README.md": "# greet\n\nA small CLI that greets someone.\n\n## Commands\n\n- `greet hello [name]`: says hello\n"
                 "- `greet bye [name]`: says goodbye\n",
    "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- `hello` and `bye`\n",
}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def check_scratch(path):
    """Refuses any scratch root but a direct ~/.cf-guide-eval-* child: rmtree and the
    process sweep trust it. A /tmp home spoils tasks: view.* refuse paths outside home."""
    home, real = Path.home().resolve(), Path(path).resolve()
    if real.parent != home or not real.name.startswith(ROOT_PREFIX):
        raise SystemExit(f"refusing scratch root {real}: want {home}/{ROOT_PREFIX}*")
    return real


def clean_env():
    return {k: v for k, v in os.environ.items() if k not in SCRUB_NAMES and not k.startswith(SCRUB_PREFIXES)}


class Home:
    """One round's scratch home, its daemon and its project."""

    def __init__(self, root, name, binary):
        self.dir, self.binary = root / name, binary
        self.home, self.repo, self.origin = self.dir / "home", self.dir / "greet", self.dir / "origin.git"
        self.plugins, self.shims, self.argv = self.dir / "plugins", root / "shims", self.dir / "argv"
        self.daemon = None
        self.project = None
        self.calls = set()  # code-foundry calls in flight
        self.stopping = False
        for d in (self.home, self.plugins, self.argv):
            d.mkdir(parents=True)
        real_home = (Path.home() / ".code-foundry").resolve()
        if self.home.resolve() == real_home or real_home in self.home.resolve().parents:
            raise SystemExit("refusing the real home")
        if len(str(self.home / "daemon.sock")) > 103:
            raise SystemExit(f"scratch home path too long for a socket: {self.home}")
        self.env = clean_env()
        self.env.update(CODE_FOUNDRY_HOME=str(self.home), CODE_FOUNDRY_BIN=str(binary),
                        CF_EVAL_ARGV=str(self.argv), PATH=f"{self.shims}:{binary.parent}:{os.environ['PATH']}")

    def cf(self, *args, timeout=60):
        """Every code-foundry call. None may run once the daemon is going: it would start
        another (Home.stop_calls)."""
        if self.stopping:
            raise RuntimeError("scratch home is stopping")
        p = subprocess.Popen([str(self.binary), *args], env=self.env, cwd=self.dir, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.calls.add(p)
        try:
            out, err = p.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            p.communicate()
            raise
        finally:
            self.calls.discard(p)
        return subprocess.CompletedProcess(p.args, p.returncode, out, err)

    def stop_calls(self):
        self.stopping = True
        for p in list(self.calls):
            p.kill()

    def cf_json(self, *args, timeout=60):
        r = self.cf(*args, "--json", timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"code-foundry {' '.join(args)}: {r.stderr or r.stdout}")
        return json.loads(r.stdout)

    def start(self):
        out = open(self.dir / "daemon.log", "wb")
        self.daemon = subprocess.Popen([str(self.binary), "daemon"], env=self.env, cwd=self.dir, stdin=subprocess.DEVNULL,
                                       stdout=out, stderr=out, start_new_session=True)
        for _ in range(100):
            if (self.home / "daemon.sock").exists():
                return
            if self.daemon.poll() is not None:
                break
            time.sleep(0.2)
        raise RuntimeError(f"scratch daemon did not start: see {self.dir}/daemon.log")

    def git(self, *args, cwd=None):
        subprocess.run(["git", *args], cwd=cwd or self.repo, env=clean_env(), check=True, capture_output=True)

    def set_up(self, model, effort, own=False):
        """own: a home task's home, with its project and cheaper workers."""
        self.repo.mkdir()
        for name, text in (OVERLAP_FIXTURE if own else FIXTURE).items():
            (self.repo / name).write_text(text)
        self.git("init", "--bare", "--initial-branch=main", str(self.origin), cwd=self.dir)
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "guide-eval")
        self.git("config", "user.email", "guide-eval@example.invalid")
        self.git("add", ".")
        self.git("commit", "-m", "greet")
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-u", "origin", "main")
        settings = {"threads.default_model": model, "threads.default_effort": effort, "threads.auto_name": "false",
                    "projects.branch_naming": "prefix", "github.dashboards_enabled": "false",
                    "notifications.dock_badge": "false", "notifications.bounce": "false",
                    "ember.model": model, "ember.effort": effort, "ember.worker_models": model, "ember.worker_effort": effort}
        if own:  # the thread under test gets its model by flag, so only the workers change
            settings.update({"threads.default_model": WORKER_MODEL, "threads.default_effort": WORKER_EFFORT,
                             "ember.worker_models": WORKER_MODEL, "ember.worker_effort": WORKER_EFFORT})
        for key, value in settings.items():
            r = self.cf("settings", "set", key, value)
            if r.returncode != 0:
                raise RuntimeError(f"settings set {key}: {r.stderr or r.stdout}")
        self.project = self.cf_json("project", "add", "--path", str(self.repo))["id"]

    def new_thread(self, name, prompt, model, effort, workspace="", worktree=True):
        place = ["--workspace", workspace] if workspace else ["--project", self.project]
        place += ["--new-worktree"] if worktree else []
        t = self.cf_json("thread", "new", *place, "--created-by=", "--focus=false",
                         "--model", model, "--effort", effort, "--name", name, "--budget", THREAD_BUDGET,
                         "--prompt", prompt, timeout=180)
        return t["id"]

    def threads(self):
        return self.cf_json("thread", "list", "--all", "--limit", "0").get("threads", [])

    def spawn_argv(self):
        """The first thread spawn's argv, for the always-loaded system prompt."""
        for f in sorted(self.argv.iterdir(), key=lambda p: p.stat().st_mtime):
            argv = f.read_bytes().decode("utf-8", "replace").split("\0")
            if "--append-system-prompt" in argv:
                return argv
        return []


def tree_of(threads, root):
    """root's id and every thread below it (created by it, transitively)."""
    ids, grew = {root}, True
    while grew:
        grew = False
        for t in threads:
            if t["id"] not in ids and t.get("createdBy") in ids:
                ids.add(t["id"])
                grew = True
    return ids


def is_busy(t):
    return t.get("status") in ("THREAD_STATUS_BUSY", "busy") or t.get("state") in ("THREAD_STATE_STARTING", "starting")


def wait_quiet(h, root, timeout, stop):
    """Blocks until root's whole tree has been quiet for SETTLE_POLLS polls: a thread's
    turn can end while its children work, and their reports wake it again."""
    deadline, quiet = time.time() + timeout, 0
    r = h.cf("thread", "wait", root, "--for", f"{int(timeout)}s", timeout=timeout + 30)
    while time.time() < deadline and not stop.is_set():
        ts = h.threads()
        ids = tree_of(ts, root)
        quiet = 0 if any(is_busy(t) for t in ts if t["id"] in ids) else quiet + 1
        if quiet >= SETTLE_POLLS:
            return True, r.stdout.strip()
        time.sleep(POLL_SECONDS)
    return False, r.stdout.strip()


def run_task(h, task, rnd, args, out, stop):
    rec = {"task": task["id"], "round": rnd}
    d = out / "runs" / f"{task['id']}.r{rnd}"
    d.mkdir(parents=True)
    t0 = time.time()
    try:
        prompt = task["prompt"].format(plugins=h.plugins, other_model=OTHER_MODEL[args.model])
        if task.get("ember"):
            h.cf_json("ember", "enable")
            root = ""
            for _ in range(60):
                root = h.cf_json("ember", "status").get("threadId", "")
                if root:
                    break
                time.sleep(1)
            r = h.cf("thread", "send", "--id", root, prompt)
            if r.returncode != 0:
                raise RuntimeError(f"thread send: {r.stderr or r.stdout}")
        else:
            # Only this task's thread gets a workspace: made here, it changes no other run.
            workspace = h.cf_json("workspace", "new", task["id"], "--projects", h.project)["id"] if task.get("workspace") else ""
            root = h.new_thread(task["id"], prompt, MODELS[args.model], args.effort, workspace, task.get("checkout") != "project")
        rec["root"] = root
        rec["settled"], rec["wait"] = wait_quiet(h, root, args.task_timeout, stop)
        ts = h.threads()
        ids = sorted(tree_of(ts, root))
        rec["threads"] = ids
        rec["models"] = sorted({t.get("model", "") for t in ts if t["id"] in ids})
        for tid in ids:
            (d / f"{tid}.json").write_text(h.cf("thread", "items", "--id", tid, "--json", timeout=120).stdout)
    except Exception as e:  # one task's failure is a recorded, invalid run; the others go on
        rec["error"] = str(e)[:500]
    rec["seconds"] = round(time.time() - t0)
    (d / "meta.json").write_text(json.dumps(rec, indent=1))
    log(f"r{rnd} {task['id']}: {rec.get('error') or ('settled' if rec.get('settled') else 'NOT settled')} in {rec['seconds']}s")
    return rec


def snapshot_guidance(h, out):
    """Sizes of what the build ships, and the system prompt, once per report."""
    argv = h.spawn_argv()
    prompt = argv[argv.index("--append-system-prompt") + 1] if argv else ""
    files, listing = {}, 0
    for f in sorted(h.home.glob("claude/.claude/skills/**/*")):
        if f.is_file():
            rel = str(f.relative_to(h.home / "claude/.claude/skills"))
            files[rel] = f.stat().st_size
            if rel.endswith("/SKILL.md"):
                listing += score.listing_bytes(f.read_text())
    (out / "guidance.json").write_text(json.dumps({"thread_prompt_bytes": len(prompt.encode()), "listing_bytes": listing,
                                                   "files": files, "spawn_argv": [a[:200] for a in argv]}, indent=1))


def record_git(h, path):
    """What the threads left in git, for a hand reading: the scratch folders go at the end.
    The origin's branches, every pair's merge, and the state of the project's own checkout."""
    def git(*args, cwd=h.origin):
        return subprocess.run(["git", *args], cwd=cwd, env=clean_env(), capture_output=True, text=True)

    heads = sorted(r.split("refs/heads/")[1] for r in git("for-each-ref", "--format=%(refname)", "refs/heads").stdout.split())
    branches = [b for b in heads if b != "main"]
    lines = [f"origin main: {git('log', '--oneline', 'main').stdout.strip()}", "", "branches:"]
    for b in branches:
        files = git("diff", "--name-only", f"main...{b}").stdout.split()
        lines.append(f"  {b}: {git('rev-list', '--count', f'main..{b}').stdout.strip()} commits, {' '.join(files)}")
    lines += ["", "pairs:"]
    for i, a in enumerate(branches):
        for b in branches[i + 1:]:
            r = git("merge-tree", "--write-tree", "--name-only", a, b)
            hit = r.stdout.split("\n\n")[0].split("\n")[1:]
            lines.append(f"  {a} + {b}: {'clean' if r.returncode == 0 else 'CONFLICT ' + ' '.join(hit)}")
    lines += ["", "project checkout:"]
    for args in (("status", "-sb"), ("log", "--oneline", "-5"), ("reflog", "-10"), ("branch", "-a"), ("stash", "list"), ("worktree", "list")):
        lines += [f"$ git {' '.join(args)}", git(*args, cwd=h.repo).stdout.rstrip()]
    path.write_text("\n".join(lines) + "\n")


def live_cost(h):
    return sum(float(t.get("costUsd") or 0) for t in h.threads())


def run_home_task(root, rnd, task, args, out, stop, homes):
    """A task with `home` gets one to itself: Ember is one thread per home, and neither its
    project nor its workers' model may reach the other tasks, whose reports stay comparable."""
    h = Home(root, f"r{rnd}-{task['id']}", args.bin)
    homes.append(h)
    h.start()
    h.set_up(MODELS[args.model], args.effort, own=True)
    args.build = h.cf("version").stdout.strip()
    run_task(h, task, rnd, args, out, stop)
    if not (out / "guidance.json").exists():
        snapshot_guidance(h, out)
    record_git(h, out / "runs" / f"{task['id']}.r{rnd}" / "git.txt")
    cost = live_cost(h)
    stop_home(h)
    return cost


def run_round(root, rnd, tasks, args, out, spent, stop, homes):
    own = [t for t in tasks if t.get("home")]
    cost = run_shared_home(root, rnd, [t for t in tasks if not t.get("home")], args, out, spent, stop, homes) if len(own) < len(tasks) else 0.0

    def launch(t):
        if stop.is_set() or spent + cost >= args.max_cost:
            log(f"r{rnd} {t['id']}: skipped, spend reached MAX_COST ${args.max_cost}")
            stop.set()
            return 0.0
        return run_home_task(root, rnd, t, args, out, stop, homes)

    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        cost += sum(pool.map(launch, own))
    (out / f"round{rnd}.json").write_text(json.dumps({"daemon_total_usd": cost}))
    return cost


def run_shared_home(root, rnd, tasks, args, out, spent, stop, homes):
    h = Home(root, f"r{rnd}", args.bin)
    homes.append(h)
    h.start()
    h.set_up(MODELS[args.model], args.effort)
    seed = h.new_thread("Shout flag behaviour", SEED_PROMPT, MODELS[args.model], args.effort)
    wait_quiet(h, seed, 300, stop)
    for d in claude_project_dirs(root):
        shutil.rmtree(d / "memory", ignore_errors=True)
    if not (out / "guidance.json").exists():
        snapshot_guidance(h, out)
    args.build = h.cf("version").stdout.strip()

    def launch(t):
        if stop.is_set():
            return None
        if spent + live_cost(h) >= args.max_cost:
            log(f"r{rnd} {t['id']}: skipped, spend reached MAX_COST ${args.max_cost}")
            stop.set()
            return None
        return run_task(h, t, rnd, args, out, stop)

    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        # Long tasks first, so a round is not one heavy task running alone at its end.
        list(pool.map(launch, sorted((t for t in tasks if not t.get("last")), key=lambda t: not t.get("heavy"))))
    # Last: t2's memory would reach every thread started after it, Ember's on-switch too.
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        list(pool.map(launch, [t for t in tasks if t.get("last")]))
    cost = live_cost(h)
    record_git(h, out / f"git-r{rnd}.txt")
    stop_home(h)
    denied = h.dir / "gh-denied.log"
    if denied.exists():
        with open(out / "gh-denied.log", "a") as f:
            f.write(denied.read_text())
    return cost


def descendants(pid):
    rows = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout.split("\n")
    kids = {}
    for row in rows:
        p = row.split()
        if len(p) == 2:
            kids.setdefault(int(p[1]), []).append(int(p[0]))
    found, todo = [], [pid]
    while todo:
        for k in kids.get(todo.pop(), []):
            found.append(k)
            todo.append(k)
    return found


def signal_all(pids, sig):
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def alive(pids):
    return [p for p in pids if subprocess.run(["kill", "-0", str(p)], capture_output=True).returncode == 0]


def stop_home(h):
    """Stops this home's daemon and what it started: only PIDs from its own tree."""
    h.stop_calls()
    if h.daemon is None:
        return
    pids = descendants(h.daemon.pid)
    h.daemon.terminate()
    try:
        h.daemon.wait(20)
    except subprocess.TimeoutExpired:
        h.daemon.kill()
        h.daemon.wait(5)
    h.daemon = None
    left = alive(pids)
    signal_all(left, signal.SIGTERM)
    time.sleep(1 if left else 0)
    signal_all(alive(left), signal.SIGKILL)


def scratch_pids(root):
    """Processes with this run's unique scratch path in their command line: a thread's
    orphan that outlived the daemon. Matches nothing of anyone else's."""
    rows = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
    me = os.getpid()
    return [int(r.split()[0]) for r in rows.splitlines() if str(root) in r and int(r.split()[0]) != me]


def lock_holders(homes):
    """A daemon that holds a scratch home's lock: one a late call auto-started would not
    be in the tree stop_home walked, and its command line has no scratch path."""
    pids = []
    for h in homes:
        lock = h.home / "daemon.lock"
        if lock.exists():
            found = subprocess.run(["lsof", "-t", str(lock)], capture_output=True, text=True).stdout.split()
            pids += [int(p) for p in found if int(p) != os.getpid()]
    return pids


def claude_project_dirs(root):
    """Claude's transcript and memory folders for the scratch paths: their names start with
    the slug of this run's unique root."""
    slug = re.sub(r"[^a-zA-Z0-9]", "-", str(root))
    return list((Path.home() / ".claude" / "projects").glob(slug + "*"))


def clean_up(root, homes):
    for h in homes:
        try:
            stop_home(h)
        except Exception as e:
            log(f"stopping {h.dir}: {e}")
    pids = scratch_pids(root) + lock_holders(homes)
    signal_all(pids, signal.SIGTERM)
    time.sleep(1 if pids else 0)
    signal_all(alive(pids), signal.SIGKILL)
    shutil.rmtree(check_scratch(root), ignore_errors=True)
    for d in claude_project_dirs(root):
        shutil.rmtree(d, ignore_errors=True)
    if root.exists() or scratch_pids(root):
        log(f"WARNING: scratch not fully removed: {root}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--bin", type=Path, required=True, help="the code-foundry build to test")
    p.add_argument("--model", choices=sorted(MODELS), required=True)
    p.add_argument("--effort", default="medium")
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--first-round", type=int, default=1, help="add rounds to an existing --out, from this one")
    p.add_argument("--heavy-runs", type=int, help="runs of the heavy tasks, when cost says fewer (default: --runs)")
    p.add_argument("--tasks", default="", help="comma-separated task ids (default: all)")
    p.add_argument("--jobs", type=int, default=6)
    p.add_argument("--task-timeout", type=int, default=1200, help="seconds per run")
    p.add_argument("--max-cost", type=float, default=24, help="stop launching runs at this spend, in USD")
    p.add_argument("--label", default="eval")
    p.add_argument("--out", type=Path, help="results folder (default: under ~/.cache/code-foundry/guide-eval)")
    args = p.parse_args()
    args.bin = args.bin.resolve()
    if not args.bin.is_file():
        raise SystemExit(f"no build at {args.bin}")
    tasks = json.loads((HERE / "tasks.json").read_text())
    if args.tasks:
        want = args.tasks.split(",")
        if unknown := set(want) - {t["id"] for t in tasks}:
            raise SystemExit(f"unknown tasks: {sorted(unknown)}")
        tasks = [t for t in tasks if t["id"] in want]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = args.out or Path.home() / ".cache/code-foundry/guide-eval" / f"{args.label}-{args.model}-{args.effort}-{stamp}"
    out.mkdir(parents=True, exist_ok=args.first_round > 1)
    root = check_scratch(Path.home() / (ROOT_PREFIX + secrets.token_hex(4)))
    root.mkdir()
    homes, stop = [], threading.Event()

    def on_signal(signum, _frame):
        stop.set()
        for h in homes:
            h.stop_calls()  # the pool below waits for its workers: free them
        raise SystemExit(f"stopped by signal {signum}")

    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, on_signal)

    failed = False
    try:
        shims = root / "shims"
        shims.mkdir()
        gh = shims / "gh"
        gh.write_text(GH_GUARD % {"real": shutil.which("gh") or "/nonexistent/gh", "log": '"$(dirname "$CF_EVAL_ARGV")/gh-denied.log"'})
        claude = shims / "claude"
        claude.write_text(CLAUDE_RECORDER % {"dir": '"$CF_EVAL_ARGV"', "real": shutil.which("claude")})
        gh.chmod(0o755)
        claude.chmod(0o755)
        spent = 0.0
        meta = {"label": args.label, "model": MODELS[args.model], "effort": args.effort, "runs": args.runs,
                "heavy_runs": args.heavy_runs or args.runs, "tasks": [t["id"] for t in tasks], "started": stamp,
                "claude": subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip()}
        for rnd in range(args.first_round, args.runs + 1):
            if stop.is_set():
                break
            subset = [t for t in tasks if not t.get("heavy") or rnd <= (args.heavy_runs or args.runs)]
            log(f"round {rnd}/{args.runs}: {len(subset)} tasks, ${spent:.2f} spent")
            spent += run_round(root, rnd, subset, args, out, spent, stop, homes)
        meta["build"] = args.build
        (out / "meta.json").write_text(json.dumps(meta, indent=1))
    except BaseException as e:
        failed = True
        log(f"FAILED: {e!r}")
    finally:
        clean_up(root, homes)
    if (out / "meta.json").exists():
        report = score.write_report(out, tasks)
        print(score.render_summary(report))
        log(f"report: {out}/report.md")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
