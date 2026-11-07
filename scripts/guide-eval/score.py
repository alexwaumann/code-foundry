#!/usr/bin/env python3
"""Score a guide eval's raw results, and compare two reports. See README.md.

    score.py report <results dir>             (re)writes report.json and report.md
    score.py compare <before> <after>         exits 1 when the merge gate fails
    score.py show <run dir>                   prints a run's threads, to hand-check a score

A dir or its report.json may be given. Only the standard library: the runner imports it.
"""
import json
import re
import statistics
import sys
from pathlib import Path

BYTES_PER_TOKEN = 2.7  # measured on Opus 5.5 for these files in the audit (2.3 to 3.0)
MIN_RUNS = 3  # a routing change needs this many runs per task: one run is too noisy
SKILLS_DIR = "/.claude/skills/"
WAKE_KEYS = ("wakes", "wake_bytes", "wake_cost", "wake_reads", "wake_git", "wake_idle", "wake_acted", "wake_chars",
             "relay_hits", "relay_total", "child_reports", "parent_reads", "parent_git")
FETCHES = re.compile(r"Monitor|Cron|ScheduleWakeup", re.I)
FETCH_TOOLS = {"Monitor", "CronCreate", "CronList", "CronDelete", "ScheduleWakeup"}
# The CLI's error lines: "code-foundry view.inline: ... outside your home directory",
# "code-foundry: unknown command ...", and a bad flag's "Run `code-foundry help ...".
CLI_ERROR = re.compile(r"^(?:code-foundry(?: [\w.-]+)*: |Run `code-foundry help )", re.M)
HEREDOC = re.compile(r"(<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n).*?\n\s*\2\b", re.S)
CLI_CALL = re.compile(r"(?:^|[\s;|&(\"'=])(?:\S*/)?(?:code-foundry|\$\{?CODE_FOUNDRY_BIN\}?\"?)[ \t]+([^\n;|&)]*)")


# Bash sets an output over 30,000 characters aside in a file and returns a preview. What the
# model takes in is the preview and whatever it reads back from that file, so a read back of a
# guidance output counts as guidance: t5's references are 37 KB, and scored by the preview alone
# one read of 29,900 bytes counted 13 times one of 37,700.
SET_ASIDE = re.compile(r"Full output saved to: (\S+)")


def calls(command):
    """The code-foundry invocations in a Bash command, each as `dotted.verb --rest`.

    `thread subscribe --at 2h` and `thread.subscribe --at 2h` both give the second. Lowercase
    positionals join the verb too (`thread.search.shout`), which the tasks' `\\b` allows.
    A heredoc's body is text (a README, a page), and so is a call in Markdown backticks."""
    found = []
    command = HEREDOC.sub(r"\1", re.sub(r"\\\n\s*", " ", command))
    for m in CLI_CALL.finditer(command):
        words = m.group(1).split()
        verb = []
        while words and re.fullmatch(r"[a-z][a-z0-9.-]*", words[0]):
            verb.append(words.pop(0))
        if verb:
            found.append(" ".join([".".join(verb), *words]))
    return found


def is_help(call):
    return call.startswith("help") or re.search(r"(^|\s)(--help|-h)(\s|$)", call) is not None


def listing_bytes(skill_md):
    """A skill's share of the always-loaded listing: its frontmatter name and description."""
    m = re.match(r"---\n(.*?)\n---", skill_md, re.S)
    head = m.group(1) if m else ""
    return sum(len(line.encode()) for line in head.splitlines() if line.startswith(("name:", "description:")))


def tool_calls(items):
    for it in items:
        v = it.get("toolCall")
        if not v:
            continue
        try:
            inp = json.loads(v.get("inputJson") or "{}")
        except ValueError:
            inp = {}
        yield v.get("name"), inp, v.get("output") or "", bool(v.get("isError")) or "ERROR" in str(v.get("status"))


# The command index, read whole or grepped for a verb.
INDEX = "reference/commands.md"


def skill_size(files, name):
    return files.get(f"{name.split(':')[-1]}/SKILL.md", 0)


def score_thread(items, task, files):
    """One thread's counts. `task` gives allow_fail, `files` the shipped sizes."""
    s = dict(skills=[], reads=[], cli=[], failed=[], help=0, guide=0, caps=0, fetches=0, index=0, guidance_bytes=0, cost=0.0, turns=0, text="")
    allow = task.get("allow_fail")
    set_aside = set()
    for it in items:
        if "turnEnd" in it:
            s["turns"] += 1
            s["cost"] += float(it["turnEnd"].get("turnCostUsd") or 0)
        if "assistantText" in it:
            s["text"] = it["assistantText"].get("text", "")
    for name, inp, out, err in tool_calls(items):
        if name == "Skill":
            skill = str(inp.get("skill"))
            s["skills"].append(skill)
            s["guidance_bytes"] += skill_size(files, skill)
        elif name == "Read":
            path = str(inp.get("file_path"))
            if path in set_aside:
                s["guidance_bytes"] += len(out.encode())
            elif SKILLS_DIR in path:
                rel = path.split(SKILLS_DIR)[1]
                s["reads"].append(rel)
                s["index"] += rel.endswith(INDEX)
                s["guidance_bytes"] += len(out.encode())
                if rel.endswith("/SKILL.md"):
                    s["skills"].append(rel.split("/")[0])
        elif name == "Bash":
            cmd = inp.get("command", "")
            found = calls(cmd)
            s["cli"] += found
            helps = sum(is_help(c) for c in found)
            guides = sum(c.startswith("guide") for c in found)
            caps = sum(c.startswith("daemon.capabilities") for c in found)
            s["help"] += helps
            s["guide"] += guides
            s["caps"] += caps
            skill_files = SKILLS_DIR in cmd
            if skill_files:
                s["reads"].append("sh: " + cmd[:90].replace("\n", " "))
                s["index"] += INDEX in cmd  # from the command: `reads` keeps only its start
            read_back = any(f in cmd for f in set_aside)
            if helps or guides or caps or skill_files or read_back:
                s["guidance_bytes"] += len(out.encode())
                if m := SET_ASIDE.search(out[:300]):
                    set_aside.add(m.group(1))
            if found and CLI_ERROR.search(out) and not (allow and re.search(allow, out)):
                s["failed"].append((found[-1][:120] + " => " + out[:160]).replace("\n", " "))
        elif name == "ToolSearch":
            if FETCHES.search(str(inp.get("query"))):
                s["fetches"] += 1
        elif name in FETCH_TOOLS:
            s["fetches"] += 1
    return s


def score_run(task, root_items, other_items, files):
    """A run's row. Routing and the verb count on the thread the prompt went to; guidance,
    wrong turns and cost on its whole tree (t6's children, Ember's worker)."""
    root = score_thread(root_items, task, files)
    rest = [score_thread(i, task, files) for i in other_items]
    every = [root, *rest]
    verb = task.get("verb")
    verb_ok = any(re.search(verb, c) for c in root["cli"] if not is_help(c)) if verb else True
    if not verb_ok and task.get("answer"):
        verb_ok = re.search(task["answer"], root["text"]) is not None
    if task.get("avoid") and any(re.search(task["avoid"], c) for c in root["cli"] if not is_help(c)):
        verb_ok = False  # the right verb beside the wrong store is still the wrong store
    want = task.get("skill")
    relay_hits, relay_total = relay_score(task, root["text"])
    root_bash = [inp.get("command", "") for name, inp, _, _ in tool_calls(root_items) if name == "Bash"]
    parent_reads = sum(bool(WAKE_READ.search(c)) for c in root["cli"] if not is_help(c))
    parent_git = sum(bool(WAKE_GIT.search(cmd)) for cmd in root_bash)
    reports = sum(c.startswith("thread.report ") or c == "thread.report" or c.startswith("thread.report.") for s in rest for c in s["cli"] if not is_help(c))
    wrong = sum(len(s["failed"]) + s["help"] + s["fetches"] for s in every)
    return dict(task=task["id"], skill_ok=(want in root["skills"]) if want else None, verb_ok=verb_ok, skills=root["skills"],
                reads=[r for s in every for r in s["reads"]], cli=root["cli"], failed=[f for s in every for f in s["failed"]],
                help=sum(s["help"] for s in every), fetches=sum(s["fetches"] for s in every),
                guide=sum(s["guide"] for s in every), caps=sum(s["caps"] for s in every), index=sum(s["index"] for s in every),
                wrong_turns=wrong, guidance_bytes=sum(s["guidance_bytes"] for s in every),
                cost=round(sum(s["cost"] for s in every), 4), turns=sum(s["turns"] for s in every), threads=len(every),
                relay_hits=relay_hits, relay_total=relay_total, child_reports=reports, parent_reads=parent_reads, parent_git=parent_git,
                **score_wakes(root_items))


# What a parent does in a wake turn to get what the wake did not tell it.
WAKE_READ = re.compile(r"^thread\.(read|items|get|reports)\b")
WAKE_GIT = re.compile(r"\bgit\b[^\n|;&]*\b(log|diff|show|fetch|merge-tree|rev-parse|ls-remote|branch)\b")
WAKE_ACT = re.compile(r"^(thread\.(new|send|respond|interrupt)|ember\.task\.(start|add))\b")


def wake_turns(items):
    """The root's wake messages, each with the items up to the next message."""
    turns, cur = [], None
    for it in items:
        if "userMessage" in it:
            cur = [] if it["userMessage"].get("origin") == "MESSAGE_ORIGIN_WAKE" else None
            if cur is not None:
                turns.append((it["userMessage"], cur))
        elif cur is not None:
            cur.append(it)
    return turns


def score_wakes(items):
    """What wakes cost the thread that gets them, and what it did with them. A turn that
    reads a child or checks git shows what the wake left out; one with no tool call and
    nothing acted on was a turn spent for nothing."""
    s = dict(wakes=0, wake_bytes=0, wake_cost=0.0, wake_reads=0, wake_git=0, wake_idle=0, wake_acted=0, wake_chars=0)
    for msg, turn in wake_turns(items):
        s["wakes"] += 1
        s["wake_bytes"] += len(msg.get("text", "").encode())
        s["wake_cost"] += sum(float(i["turnEnd"].get("turnCostUsd") or 0) for i in turn if "turnEnd" in i)
        s["wake_chars"] += sum(len(i["assistantText"].get("text", "")) for i in turn if "assistantText" in i)
        tools = list(tool_calls(turn))
        bash = [inp.get("command", "") for name, inp, _, _ in tools if name == "Bash"]
        found = [c for cmd in bash for c in calls(cmd)]
        s["wake_reads"] += any(WAKE_READ.search(c) for c in found)
        s["wake_git"] += any(WAKE_GIT.search(cmd) for cmd in bash)
        s["wake_acted"] += any(WAKE_ACT.search(c) for c in found)
        s["wake_idle"] += not tools
    return s


def relay_score(task, text):
    """How many of the task's `relay` patterns the final reply has: what a child found that
    the parent had to pass on. (hits, total); (0, 0) for a task without any."""
    want = task.get("relay", [])
    return sum(re.search(p, text) is not None for p in want), len(want)


def tokens(n_bytes):
    return round(n_bytes / BYTES_PER_TOKEN)


def write_report(out, tasks=None):
    out = Path(out)
    if tasks is None:
        tasks = json.loads((Path(__file__).parent / "tasks.json").read_text())
    by_id = {t["id"]: t for t in tasks}
    meta = json.loads((out / "meta.json").read_text())
    guidance = json.loads((out / "guidance.json").read_text()) if (out / "guidance.json").exists() else {}
    files = guidance.get("files", {})
    always = tokens(guidance.get("thread_prompt_bytes", 0) + guidance.get("listing_bytes", 0))
    rows = []
    for d in sorted((out / "runs").iterdir()):
        rec = json.loads((d / "meta.json").read_text())
        task = by_id.get(rec["task"])
        if task is None:
            continue
        root = rec.get("root", "")
        def items(tid):
            f = d / f"{tid}.json"
            return json.loads(f.read_text() or "{}").get("items", []) if f.exists() else []
        row = score_run(task, items(root), [items(t) for t in rec.get("threads", []) if t != root], files)
        row.update(round=rec["round"], root=root, seconds=rec.get("seconds"), valid=bool(rec.get("settled")) and "error" not in rec,
                   error=rec.get("error", ""), loaded_tokens=tokens(row["guidance_bytes"]))
        row["guidance_tokens"] = always + row["loaded_tokens"]
        rows.append(row)
    rounds = [json.loads(f.read_text()) for f in sorted(out.glob("round*.json"))]
    report = dict(meta=meta, always_tokens=always, thread_prompt_bytes=guidance.get("thread_prompt_bytes", 0),
                  listing_bytes=guidance.get("listing_bytes", 0), rows=rows, totals=totals(rows),
                  tasks=per_task(rows), daemon_cost=round(sum(r.get("daemon_total_usd", 0) for r in rounds), 2))
    (out / "report.json").write_text(json.dumps(report, indent=1))
    (out / "report.md").write_text(render_summary(report) + "\n\n" + render_tasks(report) + "\n")
    return report


def totals(rows):
    skill = [r for r in rows if r["skill_ok"] is not None]
    return dict(runs=len(rows), invalid=sum(not r["valid"] for r in rows),
                skill_hits=sum(bool(r["skill_ok"]) for r in skill), skill_total=len(skill),
                verb_hits=sum(r["verb_ok"] for r in rows), verb_total=len(rows),
                guidance_tokens_mean=round(statistics.mean(r["guidance_tokens"] for r in rows)) if rows else 0,
                loaded_tokens_mean=round(statistics.mean(r["loaded_tokens"] for r in rows)) if rows else 0,
                wrong_turns=sum(r["wrong_turns"] for r in rows), failed_cli=sum(len(r["failed"]) for r in rows),
                help_hops=sum(r["help"] for r in rows), fetches=sum(r["fetches"] for r in rows),
                guide_calls=sum(r["guide"] for r in rows), capabilities_calls=sum(r["caps"] for r in rows),
                commands_md_reads=sum(r["index"] for r in rows),
                cost=round(sum(r["cost"] for r in rows), 2), **wake_totals(rows))


def wake_totals(rows):
    """The wake columns over rows. Reports scored before these existed have none."""
    t = {k: sum(r.get(k, 0) for r in rows) for k in WAKE_KEYS}
    t["wake_cost"] = round(t["wake_cost"], 2)
    return t


def per_task(rows):
    out = {}
    for r in rows:
        out.setdefault(r["task"], []).append(r)
    res = {}
    for task, rs in out.items():
        g = [r["guidance_tokens"] for r in rs]
        res[task] = dict(runs=len(rs), skill=None if rs[0]["skill_ok"] is None else sum(bool(r["skill_ok"]) for r in rs),
                         verb=sum(r["verb_ok"] for r in rs), guidance_mean=round(statistics.mean(g)), guidance_min=min(g), guidance_max=max(g),
                         wrong_turns=sum(r["wrong_turns"] for r in rs), cost=round(sum(r["cost"] for r in rs), 2),
                         invalid=sum(not r["valid"] for r in rs), **wake_totals(rs))
    return res


def render_summary(rep):
    m, t = rep["meta"], rep["totals"]
    return "\n".join([
        f"# guide eval: {m['label']}, {m['model']}, {m['effort']}, {m['runs']} runs ({m.get('heavy_runs', m['runs'])} heavy)",
        f"build {m.get('build', '?')}, {m.get('claude', '?')}",
        "",
        f"- runs: {t['runs']} ({t['invalid']} invalid)",
        f"- skill loaded: {t['skill_hits']}/{t['skill_total']}",
        f"- correct verb: {t['verb_hits']}/{t['verb_total']}",
        f"- guidance tokens per run: {t['guidance_tokens_mean']} ({rep['always_tokens']} always loaded + {t['loaded_tokens_mean']} loaded)",
        f"- wrong turns: {t['wrong_turns']} ({t['failed_cli']} failed CLI, {t['help_hops']} help hops, {t['fetches']} Monitor/Cron fetches)",
        f"- guide calls {t['guide_calls']}, capabilities calls {t['capabilities_calls']}, reads of reference/commands.md {t['commands_md_reads']}",
        f"- cost: ${t['cost']} in the runs, ${rep.get('daemon_cost', 0)} by the daemon's count (seed threads included)",
    ])


def render_tasks(rep):
    lines = ["| task | runs | skill | verb | guidance tokens (min-max) | wrong | cost |", "|---|---|---|---|---|---|---|"]
    for task, s in rep["tasks"].items():
        skill = "-" if s["skill"] is None else f"{s['skill']}/{s['runs']}"
        bad = f" ({s['invalid']} invalid)" if s["invalid"] else ""
        lines.append(f"| {task} | {s['runs']}{bad} | {skill} | {s['verb']}/{s['runs']} | "
                     f"{s['guidance_mean']} ({s['guidance_min']}-{s['guidance_max']}) | {s['wrong_turns']} | ${s['cost']} |")
    if any(s.get("wakes") or s.get("relay_total") or s.get("child_reports") for s in rep["tasks"].values()):
        lines += ["", "| task | wakes | KB | wake-turn cost | reads | git | no tool | acted | reply chars | child reports | parent reads | parent git | relay |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for task, s in rep["tasks"].items():
            if s.get("wakes") or s.get("relay_total") or s.get("child_reports"):
                relay = f"{s['relay_hits']}/{s['relay_total']}" if s["relay_total"] else "-"
                lines.append(f"| {task} | {s['wakes']} | {s['wake_bytes'] / 1000:.1f} | ${s['wake_cost']} | {s['wake_reads']} | {s['wake_git']} | "
                             f"{s['wake_idle']} | {s['wake_acted']} | {s['wake_chars']} | {s['child_reports']} | {s['parent_reads']} | {s['parent_git']} | {relay} |")
    return "\n".join(lines)


def compare(before, after):
    """The comparison's text and the merge gate's verdict."""
    a, b = before["totals"], after["totals"]
    lines = [f"before: {before['meta']['label']} ({before['meta'].get('build', '?')})",
             f"after:  {after['meta']['label']} ({after['meta'].get('build', '?')})", ""]
    for name, key in (("skill loaded", "skill_hits"), ("correct verb", "verb_hits"), ("guidance tokens per run", "guidance_tokens_mean"),
                      ("loaded tokens per run", "loaded_tokens_mean"), ("wrong turns", "wrong_turns"), ("failed CLI", "failed_cli"),
                      ("help hops", "help_hops"), ("Monitor/Cron fetches", "fetches"), ("cost", "cost")):
        delta = round(b[key] - a[key], 2)
        lines.append(f"{name:24} {a[key]:>8} -> {b[key]:>8}  ({delta:+})")
    lines.append(f"{'always loaded':24} {before['always_tokens']:>8} -> {after['always_tokens']:>8}  ({after['always_tokens'] - before['always_tokens']:+})")
    lines.append("")
    if a.get("wakes") or b.get("wakes") or a.get("relay_total") or b.get("relay_total"):  # not part of the gate: read them with the runs
        for name, key in (("wakes", "wakes"), ("wake bytes", "wake_bytes"), ("wake-turn cost", "wake_cost"), ("wake turns reading a child", "wake_reads"),
                          ("wake turns checking git", "wake_git"), ("wake turns with no tool", "wake_idle"), ("wake turns that acted", "wake_acted"),
                          ("wake-turn reply chars", "wake_chars"), ("child report calls", "child_reports"), ("parent reads, whole run", "parent_reads"),
                          ("parent git calls, whole run", "parent_git"), ("relayed facts", "relay_hits")):
            x, y = a.get(key, 0), b.get(key, 0)
            lines.append(f"{name:28} {x:>8} -> {y:>8}  ({round(y - x, 2):+})")
        lines.append("")
    for task, x in before["tasks"].items():
        y = after["tasks"].get(task)
        if not y:
            continue
        for what in ("skill", "verb"):
            if (x[what] or 0) > (y[what] or 0):
                lines.append(f"dropped: {task} {what} {x[what]}/{x['runs']} -> {y[what]}/{y['runs']}")
    problems = []
    for key in ("model", "effort", "claude"):
        if before["meta"].get(key) != after["meta"].get(key):
            problems.append(f"not comparable: {key} differs ({before['meta'].get(key)} vs {after['meta'].get(key)})")
    if set(before["tasks"]) != set(after["tasks"]):
        problems.append("not comparable: the task sets differ")
    for task, y in after["tasks"].items():
        x = before["tasks"].get(task)
        if x and x["runs"] != y["runs"]:
            problems.append(f"not comparable: {task} ran {x['runs']} and {y['runs']} times")
    for name, rep in (("before", before), ("after", after)):
        if rep["totals"]["invalid"]:
            problems.append(f"{name} has {rep['totals']['invalid']} invalid runs: rerun")
        if rep["tasks"] and min(s["runs"] for s in rep["tasks"].values()) < MIN_RUNS:
            problems.append(f"{name} has a task with under {MIN_RUNS} runs")
    if b["skill_hits"] < a["skill_hits"]:
        problems.append(f"routing dropped: {a['skill_hits']} -> {b['skill_hits']}")
    if b["verb_hits"] < a["verb_hits"]:
        problems.append(f"correct verbs dropped: {a['verb_hits']} -> {b['verb_hits']}")
    if b["guidance_tokens_mean"] >= a["guidance_tokens_mean"]:
        problems.append(f"guidance tokens did not fall: {a['guidance_tokens_mean']} -> {b['guidance_tokens_mean']}")
    lines += ["", "merge gate: " + ("PASS" if not problems else "FAIL"), *[f"  {p}" for p in problems]]
    return "\n".join(lines), not problems


def show(run_dir, width=260):
    for f in sorted(Path(run_dir).glob("s-*.json")):
        print(f"== {f.stem}")
        for it in json.loads(f.read_text() or "{}").get("items", []):
            n = it.get("ordinal")
            if "userMessage" in it:
                print(f"#{n} USER:", it["userMessage"].get("text", "")[:width * 2].replace("\n", " "))
            elif "assistantText" in it:
                print(f"#{n} CLAUDE:", it["assistantText"].get("text", "")[:width * 3])
            elif "toolCall" in it:
                v = it["toolCall"]
                print(f"#{n} {v.get('name')}{' ERR' if v.get('isError') else ''}:", (v.get("inputJson") or "")[:width].replace("\\n", " "))
                print("     =>", (v.get("output") or "")[:width].replace("\n", " | "))
            elif "turnEnd" in it:
                print(f"#{n} END ${it['turnEnd'].get('turnCostUsd')}")


def load(path):
    p = Path(path)
    return json.loads((p / "report.json" if p.is_dir() else p).read_text())


def main():
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "report":
        rep = write_report(args[1])
        print(render_summary(rep) + "\n\n" + render_tasks(rep))
        return 0
    if len(args) == 3 and args[0] == "compare":
        text, ok = compare(load(args[1]), load(args[2]))
        print(text)
        return 0 if ok else 1
    if len(args) == 2 and args[0] == "show":
        show(args[1])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
