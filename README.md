# gh-org-dashboard

Local dashboard for all issues and pull requests of a GitHub org.

```sh
npm install
npm run build && npm start        # http://localhost:3001
# or for development:
npm run server & npm run dev      # http://localhost:5173
```

Filters live in the URL, bookmark a view to save it. Data is synced every 5 minutes into `data/dashboard.db`.

## Configuration

Optional `.env` in the project root:

```sh
ORG=Euro-Office                 # GitHub org to sync
GITHUB_TOKEN=                   # default: `gh auth token`
PORT=3001
TERMINAL=iterm                  # iterm or cmux, used to launch Claude Code
REPOS_DIR=~/repos/euro-office   # where checkouts live, missing repos are cloned with gh
SUPERPROJECT=DocumentServer     # repos that are submodules of it are used from there
CMUX_SOCKET_PASSWORD=           # only with cmux socketControlMode "password"
```

## Details sidebar

Click a row (or use `j`/`k`, `Esc` to close) to open its details: description, comments, checks and reviews.
From there you can comment, close issues as completed, not planned or duplicate, close PRs, and merge PRs.
Merge is only offered when CI passes and the PR is approved; otherwise a force merge asks you to type `repo#number`.

## Launching Claude Code

Every row has a `Claude…` button to start an interactive Claude Code session for a PR (review) or issue,
with an editable prompt and extra instructions. Sessions run in a separate git worktree by default.

cmux only accepts commands from processes started inside cmux by default. Either start the server from a
cmux terminal, or set `automation.socketControlMode` to `password` in `~/.config/cmux/cmux.json` and put
the password in `CMUX_SOCKET_PASSWORD`.
