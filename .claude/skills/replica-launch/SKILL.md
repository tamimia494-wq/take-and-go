---
name: replica-launch
description: >-
  Plans launch for an app rebuild: landing page, pricing and store listing,
  grounded in research and linted against platform limits. Use when the user
  says "landing page", "pricing", "App Store listing", "launch plan", or
  after /replica-brand.
---

# replica-launch

Write launch materials from the evidence in `replica/fixes.md` and brand
strategy in `replica/brand.md`.

## Rules

- No fake testimonials, user counts, star ratings, press logos or "trusted by".
- Reviews are research, not testimonials.
- Keep the original app's name out of your app name, store listing, keywords
  and ads. Do not claim rankings or prices without evidence.

## Landing page and pricing

Write a landing page with a clear audience and benefit, real product imagery,
three steps, features tied to research-backed fixes, FAQ and a call to action.
Use the new brand voice and run a contrast check.
For pricing, compare the original's public pricing page and 2–3 alternatives;
include source URLs and date read. Set at most three tiers, explain the model,
and address billing complaints with clear cancellation and renewal terms.

## Store listing

Prepare App Store and Google Play fields using their current limits; verify
requirements in the consoles before submission. The bundled `listing.py`
checks character limits and common metadata issues:

```bash
python3 .claude/skills/replica-launch/listing.py replica/launch/listing.json
```

Prepare screenshots, privacy labels, data-safety details, privacy policy,
support URL, age rating and reviewer notes.

## Output

Write `replica/launch/` with landing page, pricing, listing and launch plan.
Next: `/replica-deploy`.
