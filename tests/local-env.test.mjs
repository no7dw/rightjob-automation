import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalEnv } from "../helper/local-env.mjs";

test("project startup uses the project's provider and key instead of host agent credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "jseeker-env-"));
  try {
    const path = join(directory, ".env");
    writeFileSync(
      path,
      '# project config\nOPENAI_BASE_URL="https://api.deepseek.com/v1"\nexport OPENAI_API_KEY=project-fixture\n',
    );
    const inherited = {
      OPENAI_BASE_URL: "http://localhost:8321",
      OPENAI_API_KEY: "host-fixture",
    };
    const ordinary = { ...inherited };
    loadLocalEnv(path, { env: ordinary });
    assert.deepEqual(ordinary, inherited);
    const project = { ...inherited };
    loadLocalEnv(path, { env: project, preferFile: true });
    assert.equal(project.OPENAI_BASE_URL, "https://api.deepseek.com/v1");
    assert.equal(project.OPENAI_API_KEY, "project-fixture");
    const empty = {};
    loadLocalEnv(path, { env: empty });
    assert.deepEqual(empty, project);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
