import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalToken } from "../helper/token-file.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jseeker-token-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, ".helper-token");
}

test("generated helper token ends in a newline and remains private and stable", (t) => {
  const path = fixture(t);
  const token = loadLocalToken(path, "");
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(readFileSync(path, "utf8"), `${token}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadLocalToken(path, ""), token);
});

test("legacy token gains a newline without changing the token", (t) => {
  const path = fixture(t);
  writeFileSync(path, "legacy-token", { mode: 0o644 });
  assert.equal(loadLocalToken(path, ""), "legacy-token");
  assert.equal(readFileSync(path, "utf8"), "legacy-token\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadLocalToken(path, ""), "legacy-token");
  assert.equal(readFileSync(path, "utf8"), "legacy-token\n");
});

test("existing whitespace is trimmed for authentication and empty files recover", (t) => {
  const path = fixture(t);
  writeFileSync(path, "  legacy-token\r\n");
  assert.equal(loadLocalToken(path, ""), "legacy-token");
  writeFileSync(path, " \r\n");
  const token = loadLocalToken(path, "");
  assert.match(token, /^[a-f0-9]{48}$/);
  assert.equal(readFileSync(path, "utf8"), `${token}\n`);
});

test("environment override takes precedence without modifying the token file", (t) => {
  const path = fixture(t);
  writeFileSync(path, "file-token");
  assert.equal(loadLocalToken(path, "environment-token"), "environment-token");
  assert.equal(readFileSync(path, "utf8"), "file-token");
});

test("concurrent processes share one complete credential on first creation", async (t) => {
  const path = fixture(t);
  const moduleURL = new URL("../helper/token-file.mjs", import.meta.url).href;
  const script = `
    import { loadLocalToken } from ${JSON.stringify(moduleURL)};
    process.on("message", path => process.send(loadLocalToken(path, "")));
    process.send("ready");
  `;
  const workers = Array.from({ length: 8 }, () =>
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }),
  );
  t.after(() => workers.forEach((worker) => worker.kill()));
  await Promise.all(workers.map((worker) => once(worker, "message")));
  for (let round = 0; round < 12; round++) {
    const target = `${path}-${round}`;
    const results = workers.map((worker) => once(worker, "message"));
    workers.forEach((worker) => worker.send(target));
    const tokens = (await Promise.all(results)).map(([token]) => token);
    assert.equal(new Set(tokens).size, 1);
    assert.match(tokens[0], /^[a-f0-9]{48}$/);
    assert.equal(readFileSync(target, "utf8"), `${tokens[0]}\n`);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  }
  assert.ok(
    readdirSync(join(path, "..")).every((name) => !name.endsWith(".tmp")),
  );
});
