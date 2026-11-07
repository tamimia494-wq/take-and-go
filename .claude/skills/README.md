# Replica skill pack (project-local)

The 11 Replica skills from [Jakeschincariol/replica-skill](https://github.com/Jakeschincariol/replica-skill) are installed under `.claude/skills/` for use with Claude Code in this project. They cover recon, architecture, design, build, backend, testing, parity, user-feedback research, branding, launch and deployment.

Start a Claude Code session in this repository and ask naturally, for example:

- “Map out the public booking flow for [app]” (replica-recon)
- “Plan the architecture from `replica/recon.md`” (replica-architect)
- “Build the next screen from the recon map” (replica-build)
- “Test the app and report reproducible bugs” (replica-test)

The pack is project-local; it does not install globally in your Claude account. Python helper scripts and templates can be added as needed. The source project includes additional utilities and examples; the skills here work as instructions without requiring external dependencies.

**Clean-room use:** rebuild functionality and general UX patterns only. Do not copy source code, private APIs, proprietary assets, branding, or text. Respect the source app’s terms and access restrictions. MIT license; see `LICENSE` in the upstream repository.
