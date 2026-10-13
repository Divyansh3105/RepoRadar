const fs = require("fs/promises");
const { accessSync, readFileSync } = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const CACHE = path.join(__dirname, "scan.json");
const MAX_DEPTH = 12;
const WALKERS = 16; // concurrent readdir calls
const GIT_JOBS = 4; // concurrent repo inspections
const BUILD_DIRS = ["node_modules", ".venv", "venv", "target", ".next", "dist", "build"];
const SKIP = new Set([
  "node_modules",
  "$Recycle.Bin",
  "System Volume Information",
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "AppData",
  "Documents and Settings",
  "Application Data",
  "All Users",
  "Default User",
  "$WinREAgent",
  "Recovery",
  "msys64",
  "cygwin64",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  ".cargo",
  ".rustup",
  ".nuget",
  ".vscode",
  ".cursor",
  "venv",
  ".venv",
  "__pycache__",
  "site-packages",
]);

// Virtual or mirrored top-level folders on macOS/Linux (/System/Volumes/Data mirrors /Users, /proc and /sys are not disk).
// Matched by full path, since names like "dev" or "sys" are fine inside a home folder.
const SKIP_ABS = new Set(
  process.platform === "win32"
    ? []
    : ["/proc", "/sys", "/dev", "/run", "/System", "/Volumes", "/private", "/snap"],
);

const state = {
  scanning: false,
  startedAt: null,
  finishedAt: null,
  dirsScanned: 0,
  found: 0,
  current: "",
  drives: [],
  repos: [],
};

function load() {
  try {
    Object.assign(state, JSON.parse(readFileSync(CACHE, "utf8")), {
      scanning: false,
      current: "",
    });
    for (const r of state.repos) // caches from before buildDirs existed
      r.buildDirs ??= r.nodeModules ? [{ name: "node_modules", ...r.nodeModules }] : [];
    for (const r of state.repos) r.touchedAt ??= lastTouched(r); // caches from before touchedAt existed
  } catch {}
}

// Newest sign of life: last commit, newest uncommitted edit, or a build folder's mtime. Drives the "stale" flag.
function lastTouched(r) {
  return (
    Math.max(r.lastCommit?.at ?? 0, r.changedAt ?? 0, ...r.buildDirs.map((d) => d.modified)) || null
  );
}

// ROOTS="D:\Projects;C:\work" (":"-separated on macOS/Linux) limits the scan; unset scans every drive.
function listDrives() {
  const roots = process.env.ROOTS?.split(path.delimiter).filter(Boolean);
  if (roots?.length) return roots.map((r) => path.resolve(r));
  if (process.platform !== "win32") return ["/"];
  return [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]
    .map((l) => `${l}:\\`)
    .filter((d) => {
      try {
        accessSync(d);
        return true;
      } catch {
        return false;
      }
    });
}

// Resolves stdout, or null if git failed (not a repo, empty repo, timeout...).
function git(dir, ...args) {
  return new Promise((resolve) =>
    execFile(
      "git",
      // fsmonitor=false: a repo's own config could name a command for status to run. no-optional-locks: status must not rewrite the index.
      ["-c", "safe.directory=*", "-c", "core.fsmonitor=false", "--no-optional-locks", "-C", dir, ...args],
      { maxBuffer: 64 << 20, windowsHide: true, timeout: 60_000 },
      (err, stdout) => resolve(err ? null : stdout),
    ),
  );
}

// `git status --porcelain -b -z`: "## main...origin/main [ahead 1]" then one NUL-terminated "XY path" per changed file.
// Renames/copies are followed by an extra entry holding the source path.
function parseStatus(out) {
  const [head = "", ...entries] = out.split("\0");
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.\S+)?(?: \[.*\])?$/.exec(
    head,
  );
  const files = [];
  let untracked = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (/[RC]/.test(e.slice(0, 2))) i++;
    if (e.startsWith("??")) untracked++;
    files.push(e.slice(3));
  }
  return { branch: m ? m[1] : null, changes: files.length, untracked, files };
}

// Newest mtime among changed files (deleted ones are skipped); null if none can be stat'd.
async function newestMtime(dir, files) {
  const times = await Promise.all(
    files.map((f) =>
      fs.stat(path.join(dir, f)).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  );
  return times.reduce((a, b) => Math.max(a, b), 0) || null;
}

// `git for-each-ref` lines: "name\tupstream\t[ahead 2, behind 1]" (upstream/track may be empty, track may be "[gone]").
function parseBranches(out) {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream = "", track = ""] = line.split("\t");
      return {
        name,
        upstream: upstream || null,
        gone: track === "[gone]",
        ahead: +(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      };
    });
}

async function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile())
          total += await fs.stat(p).then(
            (s) => s.size,
            () => 0,
          );
        // symlinks skipped: pnpm/.bin links would double count
      }),
    );
  }
  return total;
}

// Regenerable folders: node_modules always; the rest only when git ignores them, since a committed dist/ or build/ is source.
// lstat, so symlinks/junctions are never measured (or offered for deletion).
async function buildDirs(dir) {
  const present = [];
  for (const name of BUILD_DIRS) {
    const s = await fs.lstat(path.join(dir, name)).catch(() => null);
    if (s?.isDirectory()) present.push([name, s.mtimeMs]);
  }
  if (!present.length) return [];
  const out = await git(dir, "check-ignore", "--", ...present.map(([n]) => n));
  const ignored = new Set((out || "").split(/\r?\n/));
  return Promise.all(
    present
      .filter(([name]) => name === "node_modules" || ignored.has(name))
      .map(async ([name, modified]) => ({
        name,
        bytes: await dirSize(path.join(dir, name)),
        modified,
      })),
  );
}

async function repoInfo(dir) {
  const [log, status, refs, remotes, stashes] = await Promise.all([
    git(dir, "log", "-1", "--format=%ct%x09%s"),
    git(dir, "status", "--porcelain", "-b", "-z"),
    git(
      dir,
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
      "refs/heads",
    ),
    git(dir, "remote"),
    git(dir, "stash", "list"),
  ]);
  const [ts, ...msg] = (log || "").trim().split("\t");
  const st = status == null ? null : parseStatus(status);
  const branches = parseBranches(refs || "");
  const info = {
    path: dir,
    name: path.basename(dir),
    lastCommit: ts ? { at: +ts * 1000, message: msg.join("\t") } : null,
    branch: st?.branch ?? null,
    changes: st?.changes ?? null, // null = git status failed
    untracked: st?.untracked ?? null,
    changedAt: st?.files.length ? await newestMtime(dir, st.files) : null,
    stashes: (stashes || "").split("\n").filter(Boolean).length,
    hasRemote: !!remotes?.trim(),
    localOnly: branches.filter((b) => !b.upstream || b.gone).map((b) => b.name),
    unpushed: branches
      .filter((b) => b.ahead)
      .map((b) => ({ name: b.name, ahead: b.ahead })),
    buildDirs: await buildDirs(dir),
  };
  info.touchedAt = lastTouched(info);
  return info;
}

// Saves are queued and go through a temp file, so overlapping saves can't leave a half-written scan.json.
let saving = Promise.resolve();
const save = () =>
  (saving = saving
    .then(async () => {
      await fs.writeFile(CACHE + ".tmp", JSON.stringify(state));
      await fs.rename(CACHE + ".tmp", CACHE);
    })
    .catch(() => {}));

// The list a rescan is collecting into; refreshes must land there too, or the swap at the end would undo them.
let pending = null;

function replace(list, dir, info) {
  const i = list.findIndex((r) => r.path === dir);
  if (i < 0) return;
  if (info) list[i] = info;
  else list.splice(i, 1);
}

// Re-inspect one known repo in place; drops the row if the folder is gone.
async function refresh(dir) {
  const info = await fs.stat(dir).then(() => repoInfo(dir), () => null);
  if (!state.repos.some((r) => r.path === dir)) return;
  replace(state.repos, dir, info);
  if (pending) replace(pending, dir, info);
  if (!state.scanning) await save();
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const [fn, resolve] = queue.shift();
    fn()
      .then(resolve)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve) => {
      queue.push([fn, resolve]);
      next();
    });
}

// ponytail: stops descending at the first .git, so repos nested inside another repo are not listed.
function walk(roots, onRepo) {
  const stack = roots.map((r) => [r, 0]);
  let busy = 0;
  return new Promise((done) => {
    const visit = async (dir, depth) => {
      state.dirsScanned++;
      state.current = dir;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.name === ".git")) return onRepo(dir);
      if (depth >= MAX_DEPTH) return;
      for (const e of entries)
        if (e.isDirectory() && !SKIP.has(e.name)) {
          const p = path.join(dir, e.name);
          if (!SKIP_ABS.has(p)) stack.push([p, depth + 1]);
        }
    };
    const pump = () => {
      while (busy < WALKERS && stack.length) {
        busy++;
        visit(...stack.pop()).finally(() => {
          busy--;
          pump();
        });
      }
      if (!busy && !stack.length) done();
    };
    pump();
  });
}

async function scan() {
  if (state.scanning) return;
  Object.assign(state, {
    scanning: true,
    startedAt: Date.now(),
    finishedAt: null,
    dirsScanned: 0,
    found: 0,
    current: "",
    drives: listDrives(),
  });
  // Rescans keep the old results visible and swap at the end; a first scan (nothing to show yet) streams in.
  const fresh = (pending = state.repos.length ? [] : state.repos);
  try {
    const limit = limiter(GIT_JOBS);
    const jobs = [];
    await walk(state.drives, (dir) => {
      jobs.push(
        limit(() =>
          repoInfo(dir).then(
            (r) => {
              fresh.push(r);
              state.found++;
            },
            () => {},
          ),
        ),
      );
    });
    await Promise.all(jobs);
    state.repos = fresh;
  } finally {
    pending = null;
    Object.assign(state, {
      scanning: false,
      finishedAt: Date.now(),
      current: "",
    });
    await save();
  }
}

module.exports = { state, load, scan, refresh, parseStatus, parseBranches, lastTouched };
