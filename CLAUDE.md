# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

An educational course (in progress) covering three topics, each with its own section under `docs/`:

- Prompt Engineering and Techniques (`docs/prompt-engineering/`)
- Building an Agent from Scratch with Claude — agentic loop, evals, tool use (`docs/building-agents/`)

`src/` is a placeholder for code examples the course will reference; it currently contains only a README and no code.

## Architecture

- `docs/` is the GitHub Pages site source. GitHub Pages is configured (or should be configured, via Settings → Pages) to build from the `main` branch's `/docs` folder using GitHub's built-in Jekyll — there is no separate build/deploy step or CI workflow.
- The site uses the `jekyll-theme-cayman` theme (set in `docs/_config.yml`), one of GitHub Pages' natively supported themes — no `remote_theme` or custom gem needed.
- Cayman only ships a single `default` layout (no `page`/`home`). Every page's front matter must use `layout: default`; content pages also set `permalink:` explicitly (e.g. `/prompt-engineering/`) since they live in `<section>/index.md` files.
- `docs/index.md` is the site landing page and links out to the three section pages.

## Commands

Preview the site locally:

```bash
cd docs
bundle install
bundle exec jekyll serve
```

Note: `bundle install` requires native gem extensions (via the `github-pages` gem) to build, which needs Xcode Command Line Tools (`make`) present on macOS. If that's not installed, local builds will fail even though the config is valid — GitHub's own Pages build service will still build it correctly.
