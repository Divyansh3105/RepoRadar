# RepoRadar

Scan your drives for git repos and show each one's last commit, uncommitted changes, branches with no remote, and stale `node_modules` size. It catches forgotten work.

## The problem

Repos pile up across drives: side projects, tutorials, half-finished experiments, old clones. Some of them hold work that exists nowhere else, like edits you never committed, a stash you meant to come back to, or a branch you never pushed. If the disk dies or you wipe the folder, that work is gone, and nothing warns you.

Meanwhile, abandoned projects keep their `node_modules`, `.venv` and `dist` folders around, quietly using gigabytes.

Checking this by hand means opening every folder and running `git status`. RepoRadar does that for every repo on every drive and puts the results in one dashboard, so you can push, commit or delete with confidence.

No dependencies, no account, nothing leaves your machine.

## Quick start

Requires Node.js 18+ and `git` on your `PATH`.

```bash
npm start
```

Then open <http://localhost:4321>. The first launch scans all drives, which can take a few minutes on large disks; results appear as they're found. After that the last scan loads instantly, and **Rescan** refreshes it.

To use another port, set `PORT` before starting:

```bash
PORT=5000 npm start
```

## What it flags

| Filter | A repo shows up when… |
|---|---|
| Needs attention | any of the four below are true |
| Uncommitted | it has modified, staged or untracked files |
| Stashed | `git stash list` is not empty |
| Unpushed | a branch is ahead of its upstream |
| Local-only | a branch has no upstream (or its upstream was deleted), or the repo has no remote at all |
| Stale build folders | it has build folders and hasn't been touched in 30+ days |

The summary at the top counts each case; click a count to filter to it. Column headings sort the table.

## Row actions

- **Open** the folder in Explorer / Finder
- **Code** opens it in VS Code (needs `code` on your `PATH`)
- **Refresh** re-checks just that repo without a full rescan
- **Copy** the path
- **Hide** it from every list; hidden repos live under the **Hidden** filter and can be unhidden there

Keyboard: <kbd>/</kbd> jumps to the search box, <kbd>Esc</kbd> clears it.

## Build folders

RepoRadar measures `node_modules`, `.venv`, `venv`, `target`, `.next`, `dist` and `build` at the repo root. `node_modules` always counts; the others only count when git ignores them, since a committed `dist/` is source, not output.

**Delete** removes a folder permanently after a confirmation. Reinstall or rebuild to get it back.

## How scanning works

- Walks every drive (`C:\`, `D:\`, … on Windows, `/` elsewhere) up to 12 levels deep.
- Skips system and cache folders such as `Windows`, `Program Files`, `AppData`, `$Recycle.Bin`, `.cache` and `node_modules`.
- Inspects up to 4 repos at a time with plain `git` commands, read-only.

## Files it writes

Both sit next to `server.js` and are git-ignored:

- `scan.json` holds the last scan results. Delete it to force a fresh scan on next start.
- `ignore.json` holds the paths you've hidden.

## Safety

The server listens only on `127.0.0.1` and rejects requests for any other host name, which blocks DNS-rebinding attacks from web pages. Actions only accept repos and build folders that the scan itself found, and deletion never follows links.

## Development

```bash
npm test
```

Runs the git-output parser checks in `test.js`. The code is three files: `scan.js` (walker and git inspection), `server.js` (HTTP API) and `public/index.html` (the dashboard).
