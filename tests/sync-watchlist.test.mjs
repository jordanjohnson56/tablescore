// Tests for scripts/sync-watchlist.sh against a throwaway setup: a bare repo
// as the remote, a clone of it as the private repo, and a fake docker that
// prints a fixture export. Nothing here touches the owner's private repo or
// reads its .env: the script is copied into the temp directory, so the .env it
// reads is one written there; the clone is passed as the first argument, as
// WATCHLIST_REPO and in that .env; and HOME and git's config point at the temp
// directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/sync-watchlist.sh", import.meta.url));

const missing = ["bash", "git", "flock"].filter((tool) => spawnSync(tool, ["--version"]).error);
const skip = missing.length ? `needs ${missing.join(", ")}` : false;

const FAKE_DOCKER = `#!/usr/bin/env bash
# Stands in for "docker compose exec ... export-watchlist.js -".
echo called >>"$FAKE_LOG"
if [ -n "\${FAKE_BLOCK:-}" ]; then
  touch "$FAKE_STARTED"
  # Wait for the test to release it, but never for more than 20 seconds.
  for _ in $(seq 400); do [ -e "$FAKE_RELEASE" ] && break; sleep 0.05; done
fi
[ -n "\${FAKE_FAIL:-}" ] && exit 1
cat "$FAKE_EXPORT"
`;

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "tablescore-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });

  const remote = join(dir, "remote.git");
  const clone = join(dir, "clone");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  git(dir, "init", "--quiet", "-b", "main", clone);
  git(clone, "remote", "add", "origin", remote);
  writeFileSync(join(clone, "README.md"), "private\n");
  git(clone, "add", "README.md");
  git(clone, "commit", "--quiet", "-m", "init");
  git(clone, "push", "--quiet", "-u", "origin", "main");

  // A copy of the script, so its app directory, and the .env it reads, are in
  // the temp dir. The script stops if .env is missing, so write one.
  mkdirSync(join(dir, "app", "scripts"), { recursive: true });
  const script = join(dir, "app", "scripts", "sync-watchlist.sh");
  copyFileSync(SCRIPT, script);
  writeFileSync(join(dir, "app", ".env"), `WATCHLIST_REPO=${clone}\n`);
  const docker = join(dir, "fake-docker");
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);

  const exportFile = join(dir, "export.json");
  const log = join(dir, "docker.log");
  Object.assign(env, {
    WATCHLIST_REPO: clone,
    DOCKER: docker,
    REFRESH_DAYS: "30",
    FAKE_EXPORT: exportFile,
    FAKE_LOG: log,
    FAKE_STARTED: join(dir, "started"),
    FAKE_RELEASE: join(dir, "release"),
  });

  return {
    dir, env, git, remote, clone,
    // Writes an export the way server/export-watchlist.js does.
    export(names, exportedAt = new Date().toISOString()) {
      const data = { exportedAt, settings: { stretch: 1 }, games: names.map((name) => ({ name, watchStage: "campaign" })) };
      const text = JSON.stringify(data, null, 2) + "\n";
      writeFileSync(exportFile, text);
      return text;
    },
    run(extra = {}) {
      const r = spawnSync("bash", [script, clone], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
      return { code: r.status, out: r.stdout, err: r.stderr };
    },
    start(extra = {}) {
      return spawn("bash", [script, clone], { env: { ...env, ...extra }, stdio: "pipe" });
    },
    remoteFile: (path = "watchlist.json") => {
      const r = spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { env, encoding: "utf8" });
      return r.status === 0 ? r.stdout : null;
    },
    commits: (where) => Number(git(where, "rev-list", "--count", "HEAD").trim()),
    remoteCommits: () => Number(git(remote, "rev-list", "--count", "main").trim()),
    ahead: () => Number(git(clone, "rev-list", "--count", "@{upstream}..HEAD").trim()),
    status: () => git(clone, "status", "--porcelain"),
    hook(where, name) {
      const file = join(where, name);
      writeFileSync(file, "#!/bin/sh\nexit 1\n");
      chmodSync(file, 0o755);
      return () => rmSync(file);
    },
  };
}

const readLog = (file) => readFileSync(file, "utf8");

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

test("a first sync commits and pushes the export", { skip }, (t) => {
  const s = setup(t);
  const text = s.export(["Bookwyrm", "Excursions"]);
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.split("\n")[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(r.out, /Synced 2 watched games/);
  assert.equal(s.remoteFile(), text);
  assert.equal(s.remoteCommits(), 2);
  assert.equal(s.status(), "");
});

test("an unchanged rerun commits nothing and leaves the clone clean", { skip }, (t) => {
  const s = setup(t);
  const first = s.export(["Bookwyrm"], daysAgo(2));
  assert.equal(s.run().code, 0);
  s.export(["Bookwyrm"]);
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No changes; the committed export is 2 days old\. Nothing to commit\./);
  assert.equal(s.remoteFile(), first);
  assert.equal(s.remoteCommits(), 2);
  assert.equal(s.status(), "");
});

test("a failed push is pushed by the next run", { skip }, (t) => {
  const s = setup(t);
  const unblock = s.hook(join(s.remote, "hooks"), "pre-receive");
  const text = s.export(["Bookwyrm"]);
  const failed = s.run();
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^sync-watchlist: push failed.*next run/m);
  assert.equal(s.ahead(), 1);

  unblock();
  s.export(["Bookwyrm"]);
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /pushing 1 unpushed commit/);
  assert.match(r.out, /Synced 1 watched games/);
  assert.equal(s.remoteFile(), text);
  assert.equal(s.commits(s.clone), 2, "no second commit");
  assert.equal(s.ahead(), 0);
});

test("a failed commit says so and is retried by the next run", { skip }, (t) => {
  const s = setup(t);
  const unblock = s.hook(join(s.clone, ".git", "hooks"), "pre-commit");
  s.export(["Bookwyrm"]);
  const failed = s.run();
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^sync-watchlist: commit failed in /m);
  assert.equal(s.commits(s.clone), 1);

  unblock();
  const text = s.export(["Bookwyrm"]);
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  assert.equal(s.remoteFile(), text);
  assert.equal(s.ahead(), 0);
  assert.equal(s.status(), "");
});

test("a failed refresh is retried by the next run", { skip }, (t) => {
  const s = setup(t);
  s.export(["Bookwyrm"], daysAgo(40));
  assert.equal(s.run().code, 0);

  const unblock = s.hook(join(s.remote, "hooks"), "pre-receive");
  const refreshed = s.export(["Bookwyrm"]);
  const failed = s.run({ REFRESH_DAYS: "30" });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /refreshing exportedAt/);

  unblock();
  s.export(["Bookwyrm"]);
  const r = s.run({ REFRESH_DAYS: "30" });
  assert.equal(r.code, 0, r.err);
  assert.equal(s.remoteFile(), refreshed);
  assert.equal(s.ahead(), 0);
});

test("a run after the routine pushed merges without an editor and pushes both", { skip }, (t) => {
  const s = setup(t);
  const unblock = s.hook(join(s.remote, "hooks"), "pre-receive");
  const text = s.export(["Bookwyrm"]);
  assert.equal(s.run().code, 1);
  unblock();

  // The routine commits its state.json from elsewhere.
  const other = join(s.dir, "routine");
  s.git(s.dir, "clone", "--quiet", s.remote, other);
  writeFileSync(join(other, "state.json"), "{}\n");
  s.git(other, "add", "state.json");
  s.git(other, "commit", "--quiet", "-m", "state");
  s.git(other, "push", "--quiet");

  // GIT_MERGE_AUTOEDIT=yes makes git open the editor even without a terminal;
  // GIT_EDITOR=false makes that fail, so this passes only with --no-edit.
  s.export(["Bookwyrm"]);
  const r = s.run({ GIT_MERGE_AUTOEDIT: "yes", GIT_EDITOR: "false", EDITOR: "false", VISUAL: "false" });
  assert.equal(r.code, 0, r.err);
  assert.equal(s.remoteFile(), text);
  assert.equal(s.remoteFile("state.json"), "{}\n");
  assert.equal(s.ahead(), 0);
});

test("a leftover watchlist.json matching the commit is put back", { skip }, (t) => {
  const s = setup(t);
  const committed = s.export(["Bookwyrm"]);
  assert.equal(s.run().code, 0);

  const unblock = s.hook(join(s.clone, ".git", "hooks"), "pre-commit");
  s.export(["Bookwyrm", "Excursions"]);
  assert.equal(s.run().code, 1);
  assert.notEqual(s.status(), "", "the failed commit left the file staged");
  unblock();

  s.export(["Bookwyrm"]);
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Nothing to commit/);
  assert.equal(s.commits(s.clone), 2);
  assert.equal(s.status(), "");
  assert.equal(s.remoteFile(), committed);
});

test("a second run while one is going stops before pulling or exporting", { skip }, async (t) => {
  const s = setup(t);
  const text = s.export(["Bookwyrm"]);
  const a = s.start({ FAKE_BLOCK: "1" });
  let aOut = "";
  a.stdout.on("data", (d) => (aOut += d));
  a.stderr.on("data", (d) => (aOut += d));
  const aDone = new Promise((resolve) => a.on("exit", resolve));
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(s.env.FAKE_STARTED)) {
      assert.ok(Date.now() < deadline, `run A never reached the export: ${aOut}`);
      await new Promise((r) => setTimeout(r, 20));
    }

    const b = s.run();
    assert.equal(b.code, 1);
    assert.match(b.err, /^sync-watchlist: another sync is running in /m);
    assert.doesNotMatch(b.out, /Pulling/);
    assert.equal(readLog(s.env.FAKE_LOG).trim().split("\n").length, 1, "B never ran the export");
    assert.equal(s.commits(s.clone), 1);
  } finally {
    // Release A before the temp dir is removed, whatever happened above.
    writeFileSync(s.env.FAKE_RELEASE, "");
  }
  assert.equal(await aDone, 0, aOut);
  assert.equal(s.remoteFile(), text);
});

test("a failed or malformed export leaves the clone untouched", { skip }, (t) => {
  const s = setup(t);
  s.export(["Bookwyrm"]);
  const failed = s.run({ FAKE_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^sync-watchlist: export failed/m);

  writeFileSync(s.env.FAKE_EXPORT, "Error: no such service\n");
  const bad = s.run();
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^sync-watchlist: export didn't look like a watchlist/m);

  assert.equal(s.commits(s.clone), 1);
  assert.equal(s.status(), "");
  assert.equal(s.remoteFile(), null);
});
