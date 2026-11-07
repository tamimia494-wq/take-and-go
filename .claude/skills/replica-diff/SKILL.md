---
name: replica-diff
description: >-
  Compares an app clone against the original: a feature parity score from the
  feature matrix (weighted by must, should, could) with the missing list in
  build order, plus a screenshot layout diff that ignores colour so a rebrand
  does not count against you. Two standard-library Python tools. Use when the
  user says "how close is my clone", "compare it to the original", "what's
  missing", "parity check", "diff the screens", "is it ready", or after
  /replica-test.
---

# replica-diff

Two standard-library Python tools, included in this skill directory:

```bash
python3 .claude/skills/replica-diff/parity.py replica/features.csv
python3 .claude/skills/replica-diff/imgdiff.py original.png clone.png --out diff.png
```

## What parity means here

**Parity means it does the same job, not that it looks the same.** The
feature score is the number that matters: can a user do everything they could
do in the original. The layout score checks structure (is the information in
the same places, in the same hierarchy), because that is what makes a switcher
feel at home. It deliberately ignores colour, because replica-brand changes
every colour on purpose. Do not chase pixel parity with the original. Its
exact look is its trade dress, and it changes before launch.

## Feature parity

Make sure `replica/features.csv` is current: every row's `clone` column is
`yes`, `partial` (with a note), `no`, or `skip` (with a reason). Priority is
weighted must=3, should=2, could=1; partial counts as half. `skip` rows and
features you added that the original does not have are excluded from the score.
Must-haves not done means not shippable.

## Layout and behaviour

Take original and clone screenshots at the same viewport and state. Use layout
mode to compare structure, not colour; use pixel mode only for your own
regression checks. Walk each flow in both apps and compare clicks, error
handling, state persistence and emails. Record each difference as: flow,
original behaviour, clone behaviour, fix or keep.

## Report

Write `replica/parity.md`: overall and feature score, layout score per screen,
missing features in build order, behaviour differences, and an honest verdict.
Open S1 bugs or missing must-haves mean not shippable. Next: `/replica-build`
for gaps, or `/replica-entrepreneur` if parity is there.
