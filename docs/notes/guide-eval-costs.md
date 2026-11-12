# Guide eval costs

Measured 2026-11-11 on `ff90960a1`, Claude Code 2.1.322, effort medium, the full 27 tasks,
ONE run per model (`RUNS=1`), to replace cost figures that came from 19- and 23-task sets.

| model | in the runs | daemon's count (seed threads included) | caps given | cap reached |
| --- | --- | --- | --- | --- |
| Sonnet 5.5 | $3.94 | $4.05 | $12 | no |
| Opus 5.5 | $7.24 | $7.34 | $20 | no |

Both finished all 27 tasks, no invalid runs; nothing failed to run. Total spend about $11.4.

The default three runs are one measured run times three: $12.15 (Sonnet) and $22.02 (Opus),
by the daemon's count, which is what `MAX_COST` is checked against. So the `MAX_COST` default
is 26 ($22.02 plus about 20%), up from 24 in the Makefile and `eval.py`. Run-to-run noise
exists, so three real runs may land a little off the product.

Tasks that dominated: the multi-thread ones. Opus: `ember-overlap` $0.82, `t6-orchestrate`
$0.66, `t10-overlap` $0.65, `ember` $0.45, `w3-ember-audit` $0.37, `t8-theme` $0.35. Sonnet:
`ember-overlap` $0.63, `t10-overlap` $0.50, `t6-orchestrate` $0.28, `ember` $0.25,
`w3-ember-audit` $0.22. The rest cost well under $0.30 each.

These are cost measurements, not a new baseline: the reports are not committed and
`guide-eval-baseline.md` is unchanged. (Sonnet scored 24/27 verbs and 19/21 skills, Opus 27/27
and 21/21, on one run each; noise, not a finding.)
