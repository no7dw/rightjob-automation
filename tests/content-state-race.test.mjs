import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const refresh = source.slice(source.indexOf("  async function refresh()"), source.indexOf("  function clearResolvedConfigurationError()"));
const begin = source.slice(source.indexOf('      const run = await api({\n        type: "LIEPIN_BEGIN"'), source.indexOf("      let emptyRounds = 0;"));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

for (const order of ["refresh-first", "begin-first"]) {
  test(`Liepin startup retains the new batch when ${order}`, async () => {
    const getState = deferred();
    const start = deferred();
    const run = { id: "new-run", jobs: [], seen: [] };
    const context = vm.createContext({
      api: ({ type }) => type === "GET_STATE" ? getState.promise : start.promise,
      clearResolvedConfigurationError() {}, render() {},
      scope: { site: "liepin" }, runTarget: () => 50,
    });
    vm.runInContext(`let state = { run: null }; let stateRevision = 0;\n${refresh}\nasync function begin() { ${begin} }`, context);
    const refreshing = vm.runInContext("refresh()", context);
    const beginning = vm.runInContext("begin()", context);
    if (order === "refresh-first") {
      getState.resolve({ run: null });
      await refreshing;
      start.resolve(run);
    } else {
      start.resolve(run);
      await beginning;
      getState.resolve({ run: null });
    }
    await Promise.all([refreshing, beginning]);
    assert.equal(vm.runInContext("state.run", context), run);
    assert.equal(vm.runInContext("state.run.jobs.length", context), 0);
  });
}
