---
name: replica-deploy
description: >-
  Prepares deployment of an app rebuild: test and parity gates, rebrand sweep,
  production setup, host, DNS, monitoring and mobile release. Use when the
  user says "deploy it", "ship it", "put it live", "connect my domain", or
  after /replica-launch.
---

# replica-deploy

Nothing goes live without the user's explicit go. The user owns accounts,
buys domains and enters passwords, payment cards and live keys. Never deploy
before the rebrand sweep is clean.

## Preflight

Run tests, parity and brand/listing checks; confirm no open S1/S2 bugs, a
successful production build, legal pages, account deletion, and that all
branding is original. Stop if any check fails and report why. Record results
in `replica/deploy.md`.

## Production setup

Use a separate production database with backups and migrations in deploy.
Configure host environment variables to match `.env.example`; use live payment
keys only in production. Verify OAuth redirect URIs, email sending domain,
DNS, HTTPS, monitoring, analytics and the core flow on the live service.

Show the user preflight results and ask for approval before making anything
public. Provide exact DNS records and commands; the user performs account and
billing steps.

## Output

Write `replica/deploy.md` with checks, results, URL, DNS records and first-week
monitoring notes.
