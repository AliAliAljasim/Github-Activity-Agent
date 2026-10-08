# Activity Monitor

A local web app that shows what is happening across your GitHub repos, and helps you understand code changes with an AI assistant.

It exists to answer two questions quickly:

1. **What has my team been doing?** Pushes, pull requests and reviews across several repos, in one place.
2. **What actually changed, and why?** Compare any two branches, a PR, or a push, then ask an assistant about the diff.

No build step and no npm dependencies. It is a small Node server plus two HTML pages, and it reads GitHub through the `gh` CLI you are already logged in with.

## Features

**Dashboard** (`/`)
- Stat tiles for pushes, open PRs, merged PRs and active contributors, each compared with the previous period
- Push chart, stackable by repo or author, with click-to-filter by day
- Activity feed and pull request list with review and CI status
- Filters for repos and authors, ranges of 24h / 7d / 30d, or a custom date range with a calendar picker
- Light and dark theme

**Compare** (`/compare`)
- Pick two branches, a pull request or a push to compare
- Commit list and changed files, as unified or side-by-side diffs with line numbers
- Collapsible panels and sortable branch, PR and push lists
- **AI assistant**, streaming answers:
  - ask about the whole comparison, one file, or code you highlight
  - it can tell which commit and push introduced a piece of code
  - answers include clickable `path:line` references that jump to and highlight the lines
- Chats are saved, and can be renamed, reopened and deleted
- Export a chat as Markdown or Slack formatting, or have the AI write a clean, refinable Slack canvas summary

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- The [GitHub CLI](https://cli.github.com) (`gh`), logged in with access to the repos you want to monitor
- For the compare assistant only: the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (`claude`), logged in. The server runs it headlessly to answer questions.
- `make` (optional, for the start/stop shortcuts)

## Setup

```bash
# 1. Get the code
git clone https://github.com/AliAliAljasim/Github-Activity-Agent.git
cd Github-Activity-Agent

# 2. Log in to GitHub (skip if `gh auth status` already works)
gh auth login

# 3. Choose which repos to monitor
cp .env.example .env
#    then edit .env and set REPOS=owner/repo-one,owner/repo-two

# 4. Start the server
make start          # or: node server.mjs
```

Open http://localhost:8000.

If you leave `REPOS` unset, the app falls back to your four most recent repos from `gh repo list`.

### Configuration

Set these in `.env`, or as environment variables (real environment variables win):

| Variable | Default | What it does |
|---|---|---|
| `REPOS` | your 4 most recent repos | Comma-separated `owner/name` list to monitor |
| `PORT` | `8000` | Port the server listens on |
| `CLAUDE_MODEL` | the CLI default | Model for the compare assistant |

### Commands

```bash
make start      # start in the background (logs to .server.log)
make stop       # stop it
make restart    # restart (needed after changing .env or server.mjs)
make status     # is it running?
```

## How it works

- `server.mjs` pulls data with `gh api` (REST and GraphQL) and serves the pages. It looks at the last 25 PRs per repo and the last 45 days of commits on every branch, grouping commits into "pushes" (same branch and author, within 30 minutes). Results are cached in memory and in `.cache/`, and refreshed in the background.
- `index.html` is the dashboard and `compare.html` is the compare page. `support.js` is the small template runtime the dashboard uses.
- The assistant calls `claude -p` on the server with the commits and patches for the current comparison, and streams the reply to the page.
- Saved chats live in `.cache/chats.json` on the machine running the server.

## Notes

- The server listens on `127.0.0.1` only. It is a personal, local tool and is not designed to be hosted publicly.
- The assistant, and anything that uses it, needs the `claude` CLI to be logged in. Without it the dashboard and diffs still work.
- Data comes from your own `gh` login, so you only see repos you have access to.
- `.env` and `.cache/` are git-ignored. `.cache/` can contain private repo content and your saved chats, so do not commit it.
- The Ask panel on the dashboard uses mock answers. Only the compare assistant is wired to a real model.
