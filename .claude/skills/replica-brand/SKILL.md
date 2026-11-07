---
name: replica-brand
description: >-
  Names and rebrands an app being rebuilt so it becomes the user's own: name
  candidates and checks, a distinct palette, logo brief, voice guide and a
  sweep for remnants of the original. Use when the user says "name my app",
  "rebrand it", "make it mine", or after /replica-entrepreneur. Always before
  /replica-launch.
---

# replica-brand

Nothing launches under the original's identity. This skill separates a
functional rebuild from the original's branding.

## Name and checks

Generate 20 candidates across descriptive, compound, invented, metaphor and
verb styles, then narrow to five. Avoid confusing similarity to the original
or other apps in the category. For every candidate, record trademark, domain,
store, handle and web checks as "to run" until actually completed. Screening
is not legal clearance; advise a trademark lawyer before investing in a name.

## Palette, logo and voice

Choose a primary hue from a different family than the original. Check WCAG AA
contrast (4.5:1 normal text, 3:1 large text and UI). Create a logo brief, not
a copied logo: it must work at small and app-icon sizes and not resemble the
original. Define three voice traits and rewrite visible strings freshly.

## Sweep

Record names, domains and colours in `replica/brand.json`, then scan the code
and filenames before launch. The bundled `sweep.py` supports this config:

```bash
python3 .claude/skills/replica-brand/sweep.py . --config replica/brand.json
```

Replace every hit and re-run until clean. Also inspect favicon, titles, email
templates, OG image and app icon by eye.

## Output

Write `replica/brand.md` and `replica/brand.json`, update design tokens and
strings, and report the sweep result. Next: `/replica-launch`.
