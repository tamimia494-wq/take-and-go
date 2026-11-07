---
name: replica-entrepreneur
description: >-
  Researches an app being rebuilt and reads what its real users say in public
  reviews, then ranks pain points and requests into a fix plan and positioning
  angle. Quotes must be real, verbatim and linked. Use when the user says
  "what do people hate about X", "read the reviews", "find the gap", or after
  /replica-diff.
---

# replica-entrepreneur

A straight copy of an app has no reason to exist. Find a reason to build yours:
what the original's users hate, in their own words, and fix it in yours.

## Non-negotiable rules

- Never fabricate reviews, quotes, ratings, counts, users or sources. If a
  source cannot be reached, say so. If there are 14 reviews, say 14.
- Every quote is verbatim and linked to its review or thread URL.
- Read pages normally in a browser. Do not scrape sources whose terms forbid
  it. Official public feeds and APIs may be used within their terms.
- Never create fake reviews. Reviewers' words are research, not testimonials.

## Collect and analyse

Aim for 100+ recent reviews across at least three sources: app stores, G2,
Capterra, Trustpilot, Reddit, Hacker News, public feature boards and changelogs.
Store rows in `replica/reviews.csv` with columns
`source,url,date,rating,text`; text must be copied exactly and every review
must have its link. Include positive and mixed reviews as well as negative ones.

Rank themes transparently and mark small samples or one-source themes as thin.
Create three lists—what users hate, what is missing, what is unsolved—with
counts, sources, and linked evidence. Pick 5–8 fixes based on evidence and cost,
add them to `replica/features.csv` as features not in the original, then write
three positioning options grounded in the evidence and recommend one.

Do not put the original's name in your app name, ads or store listing.

## Output

Write `replica/reviews.csv`, `replica/feedback.md`, and `replica/fixes.md`.
State the sample size and next step: `/replica-brand`.
