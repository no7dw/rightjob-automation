import test from "node:test";
import assert from "node:assert/strict";
import { LiepinCoordinator } from "../extension/liepin-coordinator.js";
import { canonicalURL, parseSalary, stableJSON } from "../extension/core.js";
import { validateCheckpoint, retryFailures } from "../extension/run-state.js";

function fixture({
  score = 88,
  already = false,
  contactStatus = "contact_opened",
  screenResult = null,
  screenError = null,
  bonusMatches = [],
  bonusDraftStatus = "prepared",
} = {}) {
  const state = {
    profile: { version: "cv1" },
    selected_cities: ["深圳"],
    match_threshold: 80,
    prefs: { salary_min_k: null, excluded_terms: [] },
    // Screening tests opt in explicitly; production default is off.
    title_screen_enabled: true,
  };
  const parent = { url: "https://c.liepin.com/", tab: { id: 1, windowId: 7 } };
  const tabs = new Map([[1, { id: 1, url: parent.url }]]);
  const calls = [];
  const raw = {
    source: "liepin",
    source_id: "123",
    job_id: "liepin:a:123",
    url: canonicalURL("liepin:a:123"),
    title: "CTO",
    company: "Example",
    jd_raw: "Build AI agents",
    salary_raw: "50-80k",
    salary: parseSalary("50-80k"),
    location_raw: "深圳",
    identity_verified: true,
    location_verified: false,
    extraction_status: "success",
    quality_flags: [],
    collected_at: new Date().toISOString(),
  };
  let instance;
  const browser = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              structuredClone(state[key]),
            ]),
          ),
        set: async (patch) => Object.assign(state, structuredClone(patch)),
      },
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("No tab");
        return tabs.get(id);
      },
      create: async (options) => {
        calls.push(["create", options]);
        const tab = { id: 2, ...options };
        tabs.set(2, tab);
        return tab;
      },
      update: async (id, patch) => {
        if (!tabs.has(id)) throw new Error("No tab");
        Object.assign(tabs.get(id), patch);
        calls.push(["update", id, patch]);
      },
      remove: async (id) => {
        calls.push(["remove", id]);
        tabs.delete(id);
        await instance.onRemoved(id);
      },
      sendMessage: async (id, message) => {
        calls.push([message.type, id]);
        if (message.type === "LIEPIN_VERIFY_SCOPE") return { ok: true };
        if (message.type === "LIEPIN_READ")
          return {
            ok: true,
            data: { job: structuredClone(raw), already_contacted: already },
          };
        if (message.type === "LIEPIN_CONTACT") {
          const permission = await instance.authorize({ tab: { id }, url: raw.url }, message);
          calls.push(["bonus_permission", permission]);
          if (permission.bonus_auto_send && ["sent", "send_unconfirmed"].includes(bonusDraftStatus))
            calls.push(["bonus_send_permission", await instance.authorizeBonusSend({ tab: { id }, url: raw.url }, message)]);
          return {
            ok: true,
            data: { status: contactStatus, reason: "沟通上限",
              ...(permission.bonus_message ? { bonus_draft: { status: bonusDraftStatus, message: permission.bonus_message } } : {}),
            },
          };
        }
      },
    },
  };
  let queue = Promise.resolve();
  const screenCalls = [];
  const screen = screenError
    ? async () => {
        throw new Error(screenError);
      }
    : screenResult
      ? async (payload) => {
          screenCalls.push(payload);
          return screenResult;
        }
      : null;
  instance = new LiepinCoordinator(browser, {
    serial: (fn) => {
      const result = queue.then(fn);
      queue = result.catch(() => {});
      return result;
    },
    screen,
    score: async (id) => {
      const result = {
        engine: "llm",
        match_score: score,
        verdict: "apply",
        profile_version: "cv1",
        eligibility: { status: "pass" },
        bonus_matches: bonusMatches,
      };
      state.run.scores[id] = result;
      return result;
    },
  });
  return { state, parent, tabs, calls, raw, instance, browser, screenCalls };
}
async function begin(f) {
  await f.instance.begin(f.parent, { site: "liepin", url: f.parent.url }, 2);
  return { run_id: f.state.run.id, job_id: f.raw.job_id, url: f.raw.url };
}

test("stage updates do not read or rewrite global history indexes", async () => {
  const f = fixture();
  await begin(f);
  f.state.liepin_task = { id: "task", job_id: f.raw.job_id, parent_tab: 1 };
  f.state.job_index = { historic: { score: 90 } };
  const reads = [], writes = [];
  const get = f.browser.storage.local.get, set = f.browser.storage.local.set;
  f.browser.storage.local.get = async keys => { reads.push(keys); return get(keys); };
  f.browser.storage.local.set = async patch => { writes.push(Object.keys(patch)); return set(patch); };
  await f.instance.stage("task", "scoring");
  assert.ok(reads.every(keys => !keys.includes("job_index") && !keys.includes("contacted_jobs")));
  assert.deepEqual(writes, [["run", "liepin_task"]]);
  assert.deepEqual(f.state.job_index, { historic: { score: 90 } });
  await f.instance.change(() => {});
  assert.equal(writes.length, 1, "unchanged checkpoints must not be rewritten");
});

test("bonus drafts require opt-in and grounded CV evidence, then continue", async () => {
  const bonus = { label: "AI agents", jd_quote: "Build AI agents", profile_quote: "Build AI agents" };
  for (const [enabled, grounded, expected] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const f = fixture({ bonusMatches: [bonus] });
    f.state.allow_bonus_message = enabled;
    f.state.profile.text = grounded ? "Build AI agents" : "Engineering manager";
    f.raw.jd_raw = "加分项：Build AI agents";
    const message = await begin(f);
    assert.equal((await f.instance.process(f.parent, message)).status, "contact_opened");
    assert.equal(!!f.state.run.applications[f.raw.job_id].bonus_draft, expected);
    // The filled draft keeps its detail tab open; the batch never pauses.
    assert.equal(f.tabs.has(2), expected);
    assert.equal(f.state.liepin_task, null);
    if (expected) {
      assert.equal(f.state.contacted_jobs[f.raw.job_id].bonus_draft.message, "加分项也涉及，包括AI agents等。");
      assert.equal(f.state.run.status, "running");
      assert.equal(f.state.run.stop_reason, null);
      assert.equal(f.state.run.bonus_review, undefined);
      assert.ok(f.calls.some(([name, id, patch]) => name === "update" && id === 1 && patch.active),
        "a retained active draft must return focus to the list for the next job");
      assert.equal(f.state.run.applications[f.raw.job_id].bonus_draft.status, "prepared");
      assert.equal((await f.instance.recover(f.parent)).resume, true);
    }
    await f.instance.process(f.parent, message);
    assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
  }
});

test("Liepin closes confirmed bonus sends and retains unsent or uncertain drafts", async () => {
  for (const status of ["sent", "prepared", "already_prepared", "send_unconfirmed", "send_button_missing", "editor_error"]) {
    const f = fixture({ bonusMatches: [{ label: "AI agents", jd_quote: "Build AI agents", profile_quote: "Build AI agents" }], bonusDraftStatus: status });
    f.state.allow_bonus_message = true;
    f.state.auto_send_bonus_message = true;
    f.state.profile.text = "Build AI agents";
    f.raw.jd_raw = "加分项：Build AI agents";
    const message = await begin(f);
    assert.equal((await f.instance.process(f.parent, message)).status, "contact_opened", status);
    assert.equal(f.tabs.has(2), status !== "sent", status);
    assert.equal(f.tabs.has(1), true);
    assert.equal(f.state.run.status, "running");
    assert.equal(f.state.liepin_task, null);
    assert.equal(f.state.run.applications[f.raw.job_id].bonus_draft.status, status);
    assert.equal(f.state.contacted_jobs[f.raw.job_id].bonus_draft.status, status);
    if (["sent", "send_unconfirmed"].includes(status))
      assert.deepEqual(f.calls.find(([name]) => name === "bonus_send_permission"), ["bonus_send_permission", true]);
    assert.deepEqual(f.calls.filter(([name]) => name === "remove"), status === "sent" ? [["remove", 2]] : []);
    await f.instance.process(f.parent, message);
    assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
  }
});

test("closing an inactive sent bonus tab preserves a user's unrelated tab and focus", async () => {
  const f = fixture({ bonusMatches: [{ label: "AI agents", jd_quote: "Build AI agents", profile_quote: "Build AI agents" }], bonusDraftStatus: "sent" });
  f.state.allow_bonus_message = true;
  f.state.auto_send_bonus_message = true;
  f.state.profile.text = "Build AI agents";
  f.raw.jd_raw = "加分项：Build AI agents";
  const send = f.browser.tabs.sendMessage;
  f.browser.tabs.sendMessage = async (id, message) => {
    const response = await send(id, message);
    if (message.type === "LIEPIN_CONTACT") {
      f.tabs.get(2).active = false;
      f.tabs.set(9, { id: 9, url: "https://example.com/", active: true });
    }
    return response;
  };
  await f.instance.process(f.parent, await begin(f));
  assert.equal(f.tabs.has(2), false);
  assert.equal(f.tabs.get(9).active, true);
  assert.equal(f.tabs.has(1), true);
  assert.equal(f.calls.some(([name, id]) => name === "update" && id === 1), false);
});

test("an unavailable composer keeps the contact and still continues the batch", async () => {
  const f = fixture({ bonusMatches: [{ label: "AI agents", jd_quote: "Build AI agents", profile_quote: "Build AI agents" }], bonusDraftStatus: "editor_missing" });
  f.state.allow_bonus_message = true;
  f.state.profile.text = "Build AI agents";
  f.raw.jd_raw = "加分项：Build AI agents";
  await f.instance.process(f.parent, await begin(f));
  assert.equal(f.state.run.status, "running");
  assert.equal(f.state.run.bonus_review, undefined);
  assert.equal(f.state.run.applications[f.raw.job_id].bonus_draft.status, "editor_missing");
  assert.equal(f.state.contacted_jobs[f.raw.job_id].status, "contact_opened");
  assert.equal(f.tabs.has(2), true);
});

test("retaining an inactive bonus draft does not steal focus from a user tab", async () => {
  const f = fixture({ bonusMatches: [{ label: "AI agents", jd_quote: "Build AI agents", profile_quote: "Build AI agents" }] });
  f.state.allow_bonus_message = true;
  f.state.profile.text = "Build AI agents";
  f.raw.jd_raw = "加分项：Build AI agents";
  const send = f.browser.tabs.sendMessage;
  f.browser.tabs.sendMessage = async (id, message) => {
    const response = await send(id, message);
    if (message.type === "LIEPIN_CONTACT") f.tabs.get(2).active = false;
    return response;
  };
  await f.instance.process(f.parent, await begin(f));
  assert.equal(f.tabs.has(2), true);
  assert.equal(f.calls.some(([name, id]) => name === "update" && id === 1), false);
  assert.equal(f.state.run.status, "running");
});

test("Liepin opens, scores, authorizes contact, saves success, closes only owned tab", async () => {
  const f = fixture();
  const message = await begin(f);
  const result = await f.instance.process(f.parent, message);
  assert.equal(result.status, "contact_opened");
  assert.equal(f.state.run.jobs.length, 1);
  assert.equal(f.state.contacted_jobs[f.raw.job_id].status, "contact_opened");
  assert.equal(f.state.liepin_task, null);
  assert.deepEqual(
    f.calls.filter(([name]) => name === "remove"),
    [["remove", 2]],
  );
  assert.equal(f.tabs.has(1), true);
  await f.instance.process(f.parent, message);
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
});
test("detail tab is created in the parent tab's window", async () => {
  const f = fixture();
  await f.instance.process(f.parent, await begin(f));
  const create = f.calls.find(([name]) => name === "create");
  assert.equal(create[1].windowId, 7);
  assert.equal(create[1].openerTabId, 1);
});
test("slow title screening does not block pause or open a detail afterwards", async () => {
  const f = fixture();
  const message = { ...(await begin(f)), title: "CTO" };
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.instance.screen = () => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const processing = f.instance.process(f.parent, message);
  await started;
  try {
    assert.equal(
      await Promise.race([
        f.instance.pause(f.parent),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]),
      true,
    );
  } finally {
    release([{ id: message.job_id, open: true }]);
  }
  assert.equal((await processing).status, "paused");
  assert.equal(
    f.calls.some(([name]) => name === "create"),
    false,
  );
  assert.equal(f.state.title_screen[message.job_id], undefined);
});
test("title screening discards results when criteria change during inference", async () => {
  const f = fixture();
  const message = { ...(await begin(f)), title: "CTO" };
  f.instance.screen = async () => {
    f.state.match_threshold = 90;
    return [{ id: message.job_id, open: false }];
  };
  const result = await f.instance.process(f.parent, message);
  assert.equal(result.status, "paused");
  assert.match(result.reason, /筛选条件已改变/);
  assert.equal(f.state.title_screen[message.job_id], undefined);
  assert.equal(
    f.calls.some(([name]) => name === "create"),
    false,
  );
});
test("pause aborts the outstanding title request and releases the coordinator", async () => {
  const f = fixture();
  const message = { ...(await begin(f)), title: "CTO" };
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.instance.screen = (_titles, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
      entered();
    });
  const processing = f.instance.process(f.parent, message);
  await started;
  await f.instance.pause(f.parent);
  assert.equal((await processing).status, "paused");
  assert.equal(f.instance.busy, false);
  assert.equal(
    f.calls.some(([name]) => name === "create"),
    false,
  );
});
test("closing an inactive detail leaves the user's active tab alone", async () => {
  const f = fixture({ score: 79 });
  f.instance.score = async () => {
    f.tabs.get(2).active = false;
    return { match_score: 79 };
  };
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "below_threshold",
  );
  assert.equal(
    f.calls.some(([name, id]) => name === "remove" && id === 2),
    true,
  );
  assert.equal(
    f.calls.some(([name, id]) => name === "update" && id === 1),
    false,
  );
});
test("closing an active detail returns to its parent", async () => {
  const f = fixture({ score: 79 });
  await f.instance.process(f.parent, await begin(f));
  assert.equal(
    f.calls.some(
      ([name, id, patch]) => name === "update" && id === 1 && patch.active,
    ),
    true,
  );
});
test("low score closes detail and continues without clicking contact", async () => {
  const f = fixture({ score: 79 });
  const result = await f.instance.process(f.parent, await begin(f));
  assert.equal(result.status, "below_threshold");
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
  assert.equal(f.state.run.status, "running");
});
test("continue-chat is recorded without a second click", async () => {
  const f = fixture({ already: true });
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "already_contacted",
  );
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
});
test("popup pauses whole workflow, preserves detail, and never records successful contact", async () => {
  const f = fixture({ contactStatus: "paused" });
  const message = await begin(f);
  assert.equal((await f.instance.process(f.parent, message)).status, "paused");
  assert.match(f.state.run.stop_reason, /沟通上限/);
  assert.equal(f.state.run.status, "paused");
  assert.equal(f.tabs.has(2), true);
  assert.equal(f.state.contacted_jobs[f.raw.job_id], undefined);
  assert.equal(f.state.liepin_task.contact_clicked, true);
  // A worker restart cannot turn an uncertain send into another send.
  await f.instance.recover(f.parent);
  await f.instance.begin(f.parent, f.state.run.scope, 2);
  assert.equal((await f.instance.process(f.parent, message)).status, "paused");
  assert.match(f.state.run.stop_reason, /此前沟通结果未确认/);
  assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
});
test("title screening defaults to off and opens details directly", async () => {
  const f = fixture({ screenResult: [{ id: "liepin:a:123", open: false }] });
  delete f.state.title_screen_enabled;
  const message = { ...(await begin(f)), title: "电话销售专员" };
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.screenCalls.length, 0);
  assert.equal(f.state.title_screen?.["liepin:a:123"], undefined);
  // The card went straight through the full pipeline to contact.
  assert.equal(
    f.state.run.applications["liepin:a:123"]?.status,
    "contact_opened",
  );
});

test("LLM title screen skips mismatched cards without opening details", async () => {
  const f = fixture({ screenResult: [{ id: "liepin:a:123", open: false }] });
  const message = { ...(await begin(f)), title: "电话销售专员" };
  assert.equal((await f.instance.process(f.parent, message)).status, "skipped");
  assert.equal(
    f.calls.some(([name]) => name === "create"),
    false,
  );
  assert.equal(
    f.state.run.applications["liepin:a:123"].status,
    "title_skipped",
  );
  // Title skips never enter run.jobs, so run.seen must not include them
  // either — the checkpoint dedup invariant stays intact.
  assert.equal(f.state.run.seen.includes("liepin:a:123"), false);
  validateCheckpoint(f.state.run);
  assert.equal(f.screenCalls.length, 1);
  assert.equal(f.state.run.status, "running");
  // Finished jobs bypass screening entirely on later passes.
  await f.instance.process(f.parent, message);
  assert.equal(f.screenCalls.length, 1);
});

test("title screen pass records the verdict and opens the detail", async () => {
  const f = fixture({ screenResult: [{ id: "liepin:a:123", open: true }] });
  const message = { ...(await begin(f)), title: "资深AI工程师" };
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(f.state.title_screen["liepin:a:123"].open, true);
});

test("cached verdict skips screening and the card", async () => {
  const f = fixture({ screenResult: [{ id: "liepin:a:123", open: false }] });
  await f.instance.begin(f.parent, { site: "liepin", url: f.parent.url }, 2);
  // Prime the cache the way a previous batch would have.
  f.state.title_screen = {
    "liepin:a:123": {
      open: false,
      criteria: stableJSON({
        profile: "cv1",
        model: "",
        reasoning_effort: "auto",
        base_url: "",
        prefs: { salary_min_k: null, excluded_terms: [] },
        cities: ["深圳"],
        threshold: 80,
      }),
      at: new Date().toISOString(),
    },
  };
  const result = await f.instance.process(f.parent, {
    run_id: f.state.run.id,
    job_id: "liepin:a:123",
    url: f.raw.url,
    title: "电话销售专员",
  });
  assert.equal(result.status, "skipped");
  assert.equal(f.screenCalls.length, 0);
  assert.equal(
    f.state.run.applications["liepin:a:123"].status,
    "title_skipped",
  );
});

test("screen failure falls back to opening details", async () => {
  const f = fixture({ screenError: "模型不可用" });
  const message = { ...(await begin(f)), title: "资深AI工程师" };
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.notEqual(
    f.state.run.applications["liepin:a:123"]?.status,
    "title_skipped",
  );
});

test("only the current controlled detail may authorize contact", async () => {
  const f = fixture({ contactStatus: "paused" });
  await f.instance.process(f.parent, await begin(f));
  await assert.rejects(
    f.instance.authorize(
      { tab: { id: 99 }, url: f.raw.url },
      { task_id: f.state.liepin_task.id, job_id: f.raw.job_id },
    ),
    /暂停|失效/,
  );
});
test("changing parent scope prevents contact authorization", async () => {
  const f = fixture();
  const send = f.browser.tabs.sendMessage;
  f.browser.tabs.sendMessage = async (id, msg) =>
    msg.type === "LIEPIN_VERIFY_SCOPE" ? { ok: false } : send(id, msg);
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "paused",
  );
  assert.equal(f.state.liepin_task.contact_clicked, false);
  assert.equal(f.tabs.has(2), true);
});
test("manual detail close persists a paused checkpoint", async () => {
  const f = fixture({ contactStatus: "paused" });
  await f.instance.process(f.parent, await begin(f));
  await f.instance.onRemoved(2);
  assert.match(f.state.run.stop_reason, /标签页已关闭/);
  assert.equal(f.state.run.status, "paused");
});

test("pause while scoring prevents a later contact", async () => {
  const f = fixture();
  const message = await begin(f);
  const score = f.instance.score;
  f.instance.score = async (id) => {
    const result = await score(id);
    await f.instance.pause(f.parent);
    return result;
  };
  assert.equal((await f.instance.process(f.parent, message)).status, "paused");
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
  assert.equal(f.tabs.has(2), true);
});

test("blacklist and other cities do not send a model request or contact", async () => {
  for (const mode of ["blacklist", "city"]) {
    const f = fixture();
    if (mode === "blacklist") f.state.prefs.excluded_terms = ["CTO"];
    else f.state.selected_cities = ["上海"];
    f.instance.score = async () => {
      throw new Error("must not score");
    };
    const result = await f.instance.process(f.parent, await begin(f));
    assert.equal(result.status, mode === "city" ? "city_skipped" : "blacklist");
    assert.equal(
      f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
      false,
    );
  }
});

test("model change during scoring cannot authorize a stale contact", async () => {
  const f = fixture();
  const message = await begin(f);
  const score = f.instance.score;
  f.instance.score = async (id) => {
    const result = await score(id);
    f.state.llm_model = "another-model";
    return result;
  };
  assert.equal((await f.instance.process(f.parent, message)).status, "paused");
  assert.equal(f.state.liepin_task.contact_clicked, false);
  assert.match(f.state.run.stop_reason, /模型或筛选条件已改变/);
});

test("a persisted send confirmed by continue-chat recovers as success without resending", async () => {
  const f = fixture({ contactStatus: "paused" });
  const message = await begin(f);
  await f.instance.process(f.parent, message);
  const send = f.browser.tabs.sendMessage;
  f.browser.tabs.sendMessage = async (id, msg) => {
    const response = await send(id, msg);
    if (msg.type === "LIEPIN_READ") response.data.already_contacted = true;
    return response;
  };
  await f.instance.recover(f.parent);
  await f.instance.begin(f.parent, f.state.run.scope, 2);
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.state.run.applications[f.raw.job_id].status, "contact_opened");
  assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
  assert.equal(f.state.liepin_task, null);
});

test("unreadable Liepin JD is preserved as partial and skipped without stopping the list", async () => {
  const f = fixture();
  f.raw.jd_raw = "Build \ue123 agents";
  f.raw.extraction_status = "partial";
  f.raw.quality_flags = ["jd_private_font"];
  f.instance.score = async () => {
    throw new Error("must not score unreadable JD");
  };
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "failed",
  );
  assert.equal(f.state.run.jobs[0].extraction_status, "partial");
  assert.equal(f.state.run.status, "running");
  assert.match(f.state.run.applications[f.raw.job_id].reason, /私有字体/);
  assert.ok(f.state.run.score_failures[f.raw.job_id]);
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
});

test("one review-required job does not stop or consume the target before the next job", async () => {
  const f = fixture();
  const message = await begin(f);
  const score = f.instance.score;
  f.instance.score = async (id) => {
    const result = await score(id);
    return { ...result, requirements_status: "unknown" };
  };
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "review_required",
  );
  assert.deepEqual(f.state.run.applications[f.raw.job_id].blockers, [
    "requirements_unknown",
  ]);
  assert.equal(f.state.run.status, "running");
  assert.equal(f.state.liepin_task, null);
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
  assert.equal((await f.instance.process(f.parent, message)).status, "skipped");
  f.raw.job_id = "liepin:a:124";
  f.raw.url = canonicalURL(f.raw.job_id);
  f.instance.score = score;
  assert.equal(
    (
      await f.instance.process(f.parent, {
        ...message,
        job_id: f.raw.job_id,
        url: f.raw.url,
      })
    ).status,
    "contact_opened",
  );
  assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
});

test("an explicitly unmet requirement is rejected without stopping the next job", async () => {
  const f = fixture();
  const score = f.instance.score;
  f.instance.score = async (id) => ({
    ...(await score(id)),
    requirements_status: "unmet",
  });
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "rejected",
  );
  assert.equal(f.state.run.status, "running");
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
});

test("a transient score failure retries once and still contacts only once", async () => {
  const f = fixture();
  const score = f.instance.score;
  let attempts = 0;
  f.instance.score = async (id) => {
    if (++attempts === 1) throw new Error("fetch failed");
    return score(id);
  };
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "contact_opened",
  );
  assert.equal(attempts, 2);
  assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
});

test("persistent score timeouts are bounded, skipped, and can be explicitly retried", async () => {
  const f = fixture();
  const message = await begin(f);
  const score = f.instance.score;
  let attempts = 0;
  f.instance.score = async () => {
    attempts++;
    throw new Error("本地 Helper 请求超时");
  };
  assert.equal((await f.instance.process(f.parent, message)).status, "failed");
  assert.equal(attempts, 2);
  assert.equal(f.state.run.status, "running");
  assert.ok(f.state.run.score_failures[f.raw.job_id]);
  assert.equal(f.state.liepin_task, null);
  assert.equal((await f.instance.process(f.parent, message)).status, "skipped");
  assert.equal(attempts, 2);
  await f.instance.pause(f.parent);
  retryFailures(f.state.run);
  await f.instance.begin(f.parent, f.state.run.scope, 2);
  f.instance.score = score;
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
});

test("valid JSON with an invalid score retries then skips instead of pausing the batch", async () => {
  const f = fixture();
  let attempts = 0;
  f.instance.score = async () => { attempts++; throw new Error("LLM 匹配分须为0到100"); };
  assert.equal((await f.instance.process(f.parent, await begin(f))).status, "failed");
  assert.equal(attempts, 2);
  assert.equal(f.state.run.status, "running");
  assert.equal(f.state.liepin_task, null);
  assert.equal(f.calls.some(([name]) => name === "LIEPIN_CONTACT"), false);
});

test("a slow detail is refreshed once; persistent failure skips only that job", async () => {
  for (const persistent of [false, true]) {
    const f = fixture();
    const read = f.instance.readOnce.bind(f.instance);
    let attempts = 0;
    f.instance.readOnce = async (task) => {
      if (++attempts === 1 || persistent) throw new Error("猎聘详情加载超时");
      return read(task);
    };
    f.browser.tabs.reload = async (id) => {
      f.calls.push(["reload", id]);
    };
    assert.equal(
      (await f.instance.process(f.parent, await begin(f))).status,
      persistent ? "failed" : "contact_opened",
    );
    assert.equal(attempts, 2);
    assert.deepEqual(
      f.calls.filter(([name]) => name === "reload"),
      [["reload", 2]],
    );
    assert.equal(f.state.run.status, "running");
  }
});

test("a reread can repair a partial JD while preserving the original snapshot", async () => {
  const f = fixture();
  const message = await begin(f);
  f.raw.jd_raw = "\ue123";
  f.raw.extraction_status = "partial";
  f.raw.quality_flags = ["jd_private_font"];
  assert.equal((await f.instance.process(f.parent, message)).status, "failed");
  await f.instance.pause(f.parent);
  retryFailures(f.state.run);
  f.raw.jd_raw = "Build AI agents";
  f.raw.extraction_status = "success";
  f.raw.quality_flags = [];
  await f.instance.begin(f.parent, f.state.run.scope, 2);
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.state.run.jobs.length, 1);
  assert.equal(f.state.run.jobs[0].extraction_status, "success");
  assert.equal(f.state.run.extraction_history[0].extraction_status, "partial");
});

test("a list refresh during scoring safely cancels then resumes the same detail", async () => {
  const f = fixture();
  const message = await begin(f);
  const score = f.instance.score;
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.instance.score = async (id) => {
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
    return score(id);
  };
  const processing = f.instance.process(f.parent, message);
  await started;
  assert.deepEqual(await f.instance.recover(f.parent), {
    resume: true,
    pending: true,
  });
  release();
  assert.equal((await processing).status, "paused");
  assert.deepEqual(await f.instance.recover(f.parent), {
    resume: true,
    pending: false,
  });
  assert.equal(
    f.calls.some(([name]) => name === "LIEPIN_CONTACT"),
    false,
  );
  await f.instance.begin(f.parent, f.state.run.scope, 2);
  f.instance.score = score;
  assert.equal(
    (await f.instance.process(f.parent, message)).status,
    "contact_opened",
  );
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "LIEPIN_CONTACT").length, 1);
});

test("manual pause and an uncertain contact never auto-resume on reload", async () => {
  const f = fixture();
  await begin(f);
  await f.instance.pause(f.parent);
  assert.equal((await f.instance.recover(f.parent)).resume, false);
  const uncertain = fixture({ contactStatus: "paused" });
  await uncertain.instance.process(uncertain.parent, await begin(uncertain));
  assert.equal(
    (await uncertain.instance.recover(uncertain.parent)).resume,
    false,
  );
  assert.equal(
    uncertain.calls.filter(([name]) => name === "LIEPIN_CONTACT").length,
    1,
  );
});

test("manual pause can cancel an automatic resume even between jobs", async () => {
  const f = fixture();
  await begin(f);
  assert.equal((await f.instance.recover(f.parent)).resume, true);
  assert.equal(await f.instance.pause(f.parent), true);
  assert.equal((await f.instance.recover(f.parent)).resume, false);
});

test("identity changes are never treated as transient detail failures", async () => {
  const f = fixture();
  f.instance.readOnce = async () => {
    f.tabs.get(2).url = canonicalURL("liepin:a:999");
    throw new Error("猎聘详情加载超时");
  };
  f.browser.tabs.reload = async () => {
    throw new Error("must not reload");
  };
  assert.equal(
    (await f.instance.process(f.parent, await begin(f))).status,
    "paused",
  );
  assert.match(f.state.run.stop_reason, /跳转/);
  assert.equal(f.state.run.resume_on_reload, false);
});


test("bonus auto-send authorization needs both opt-ins and is durable and one-shot", async () => {
  for (const [bonus, auto, allowed] of [[false, true, false], [true, false, false], [true, true, true]]) {
    const f = fixture();
    await begin(f);
    f.state.allow_bonus_message = bonus;
    f.state.auto_send_bonus_message = auto;
    f.state.liepin_task = { id: "task", job_id: f.raw.job_id, child_tab: 2, contact_clicked: true, stage: "confirming_contact" };
    // Capture the task criteria through the normal processing setup.
    const original = f.browser.tabs.sendMessage;
    f.state.liepin_task = null;
    let permission;
    f.browser.tabs.sendMessage = async (id, message) => {
      const result = await original(id, message);
      if (message.type === "LIEPIN_CONTACT") {
        const sender = { tab: { id }, url: f.raw.url };
        const request = { task_id: f.state.liepin_task.id, job_id: f.raw.job_id };
        permission = await f.instance.authorizeBonusSend(sender, request);
        assert.equal(await f.instance.authorizeBonusSend(sender, request), false);
      }
      return result;
    };
    await f.instance.process(f.parent, { run_id: f.state.run.id, job_id: f.raw.job_id, url: f.raw.url });
    assert.equal(permission, allowed);
  }
});


test("upstream unavailable messages and Helper overload are retried then skipped, not batch pauses", async () => {
  for (const error of [new Error("Upstream service temporarily unavailable"), Object.assign(new Error("Helper busy"), { status: 429 }), Object.assign(new Error("provider failure"), { status: 503 })]) {
    const f = fixture();
    let attempts = 0;
    f.instance.score = async () => { attempts++; throw error; };
    const message = await begin(f);
    assert.equal((await f.instance.process(f.parent, message)).status, "failed");
    assert.equal(attempts, 2);
    assert.equal(f.state.run.status, "running");
    assert.equal(f.state.liepin_task, null);
    assert.equal(f.calls.some(([name]) => name === "LIEPIN_CONTACT"), false);
  }
});
