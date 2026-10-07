# RepoRadar

Scans every drive for git repositories and surfaces forgotten work: uncommitted changes, stashes, unpushed commits, local-only branches, and stale build folders eating disk space.

## Run

```bash
npm start
```

Opens on http://localhost:4321 (set `PORT` to change). The first launch scans all drives; results are cached in `scan.json` and **Rescan** refreshes them.

## Features

- Filters: needs attention, uncommitted, stashed, unpushed, local-only, stale build folders
- Per repo: open folder, open in VS Code, refresh, copy path, hide (saved to `ignore.json`)
- Delete git-ignored build folders (`node_modules`, `dist`, `target`, `.venv`, …) after confirmation

The server only listens on `127.0.0.1` and rejects requests for other hosts.

## Test

```bash
npm test
```
