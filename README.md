# gh-org-dashboard

Local dashboard for all issues and pull requests of one or more GitHub orgs and repos.

```sh
npm install
npm run build && npm start        # http://localhost:3001
# or for development:
npm run server & npm run dev      # http://localhost:5173
```

Filters live in the URL. Use "Save current filters" in the sidebar to keep a named view, together with the selected preset. Data is synced every 5 minutes into `data/dashboard.db`.

## Desktop app

A macOS app built with [Tauri](https://tauri.app) wraps the same server and UI. It needs Rust (`brew install rust`).

```sh
npm run app       # builds src-tauri/target/release/bundle/macos/GH Dashboard.app and a .dmg
npm run app:dev   # runs it unbundled
npm run app:install  # builds and installs it to /Applications
```

The build downloads the official Node binary matching your `node -v` and bundles it with the server.
The app keeps its database, `presets.json`, `.env` and `server.log` in `~/Library/Application Support/local.gh-org-dashboard/`.
It uses `gh`, `git` and `claude` from your login shell's PATH.
`app:install` seeds a new app data folder from `data/dashboard.db` and `presets.json` when they exist.

## Configuration

Teams are defined as presets on the Settings page, which opens on first start. They are stored in the
untracked `presets.json`; see `presets.example.json` for the format. Each entry is either an org or a single `owner/repo`:

```json
{
  "web": ["my-org"],
  "mobile": ["my-org/ios-app", "other-org/android-app"]
}
```

All presets are synced into one database, and the header switches between them.
Authors count as members when they belong to the org that owns the repo.

The Settings page also holds the coding agent options: the terminal (iTerm or cmux), the agent
(Claude Code or a custom command such as `codex {prompt}`), the folder with your checkouts, an optional
superproject whose submodules are used instead of separate checkouts, and the review prompt.

Optional `.env` in the project root:

```sh
GITHUB_TOKEN=                   # default: `gh auth token`
PORT=3001
CMUX_SOCKET_PASSWORD=           # only with cmux socketControlMode "password"
```

## Details sidebar

Click a row (or use `j`/`k`, `Esc` to close) to open its details: description, comments, checks and reviews.
From there you can comment, close issues as completed, not planned or duplicate, close PRs, and merge PRs.
Merge is only offered when CI passes and the PR is approved; otherwise a force merge asks you to type `repo#number`.

## Launching a coding agent

Every row has a terminal button to start an interactive coding agent session for a PR (review), issue or advisory,
with an editable prompt and extra instructions. Claude Code sessions run in a separate git worktree by default.

The checkout is searched up to four levels below the repository folder, including nested repositories and
submodules (for example `~/repos/nextcloud/server/apps-extra/deck`), by matching any git remote. When several
checkouts match, the dialog asks which one to use and stores it as the default in `mapping.json`
(`{ "owner/repo": "~/path" }`, next to `presets.json`). Without a match the repository is cloned into the folder.

cmux only accepts commands from processes started inside cmux by default. Either start the server from a
cmux terminal, or set `automation.socketControlMode` to `password` in `~/.config/cmux/cmux.json` and put
the password in `CMUX_SOCKET_PASSWORD`.

## AI review

The "AI review" tab of a PR runs the review prompt in the background on a detached worktree of the PR head
under `data/reviews/`, and shows the result when it is done. "Rerun" reviews what changed since the last run,
"Fresh review" starts over, and questions refine the review. Claude Code resumes its session and only gets
read-only tools (`--permission-mode dontAsk`). A custom agent uses the background review command from Settings,
gets earlier turns in its prompt, and must be made read-only by that command.

Next to the terminal button, every PR row has an AI review button: it starts a review, spins while it runs,
turns green when it's ready or red when it failed, and then opens the tab. The "AI reviews" page lists all
reviews, suggests open PRs that request your review, and "Prune" (there or in the tab) deletes a review
together with its worktree.
