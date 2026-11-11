"""Deterministic extension E2E fixtures; separate from required live Brave acceptance."""

import asyncio
import json
import os
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright, expect
from boss_bonus_browser_test import verify_boss_bonus, boss_fixture_response

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts/liepin"
ART.mkdir(parents=True, exist_ok=True)
SEEN_INPUTS = []
MODEL_RELEASE = threading.Event()
MODEL_RELEASE.set()
SCREEN_RELEASE = threading.Event()
SCREEN_RELEASE.set()
SCREEN_ENTERED = threading.Event()


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "预筛" in request["messages"][0]["content"]:
            SCREEN_ENTERED.set()
            SCREEN_RELEASE.wait(timeout=5)
            body = json.dumps({"choices":[{"message":{"content":'{"results":[]}'}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass
            return
        payload = json.loads(request["messages"][1]["content"])
        SEEN_INPUTS.append(payload)
        MODEL_RELEASE.wait(timeout=5)
        score = 40 if payload["job"].get("source_id") == "100" else 95
        body = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "match_score": score,
                                    "verdict": "apply" if score >= 80 else "reject",
                                    "bonus_matches": ([{"label":"production AI agents", "jd_quote":"有AI Agent平台建设经验", "profile_quote":"I build production AI agents and lead engineering teams."}] if "有AI Agent平台建设经验" in payload["job"]["jd"] else []),
                                    "requirements": ([{
                                        "requirement": "英语", "jd_quote": "英语流利" if payload["job"].get("source_id") == "200" else "英文可以作为工作语言(CET6)",
                                        "status": "unknown", "reason": "简历未见证据",
                                    }] if payload["job"].get("source_id") in ("200", "201") else []),
                                }
                            )
                        }
                    }
                ]
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


LIST = """<!doctype html><html><head><meta charset="utf-8"></head><body>
<input placeholder="搜索职位、公司"><div id="jobs">
<div class="card"><a target="_blank" href="https://www.liepin.com/a/100.shtml?tracking=one">工程师【深圳】</a><span>30-50k</span></div>
<div class="card"><a target="_blank" href="https://www.liepin.com/a/101.shtml">CTO【深圳】</a><span>50-80k</span></div>
<div class="card"><a target="_blank" href="https://www.liepin.com/a/102.shtml">Agent总监【深圳】</a><span>50-80k</span></div>
</div></body></html>"""


def detail(id, mode="normal"):
    button = "继续聊" if id == "101" else "聊一聊"
    chat = '<div role="dialog" class="ant-im-modal im-ui-basic-chat-modal"><div class="im-ui-chat-container">沟通已建立</div></div><div role="dialog" id="im-basic-contact" class="ant-im-drawer-content">我的沟通</div>'
    if id == "300":
        chat = chat.replace("沟通已建立", '沟通已建立<textarea placeholder="输入消息"></textarea><button onclick="window.sendClicks=(window.sendClicks||0)+1;document.querySelector(\'textarea\').value=\'\'">发送</button>')
    effect = (
        "document.querySelector('.btn-chat').innerText='继续聊';document.body.insertAdjacentHTML('beforeend',"
        + json.dumps(chat)
        + ")"
    )
    if mode == "popup":
        effect = "document.body.insertAdjacentHTML('beforeend','<div role=dialog>您已达到沟通上限</div>')"
    requirement = "英语流利" if id == "200" else "<br>加分项：有AI Agent平台建设经验" if id == "300" else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"></head><body><div class="job-apply-content"><div class="name-box"><span class="name">Agent CTO {id}</span><span class="salary">50-80k</span></div><div class="job-properties"><span>深圳</span><span>8年以上</span><span>本科</span></div></div><div class="company-name">Example</div><section class="recruiter-container"><a class="btn-chat" href="javascript:;" onclick="onContact()">{button}</a></section><section class="job-intro-container"><dl class="paragraph"><dt>职位介绍</dt><dd data-selector="job-intro-content">Build production AI agents and lead platform engineering. 负责安全验证系统与访问过于频繁告警模块开发。 {requirement}</dd></dl></section><script>function onContact(){{window.clicks=(window.clicks||0)+1;{effect};}}</script></body></html>"""


async def verify_liepin_bonus(ctx, worker, parent, listing, wait_state, auto_send=False):
    # Opt-in persists; verified bonus evidence fills a draft without
    # pressing Send, and the next JD completes without confirmation.
    await worker.evaluate("()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},evaluation_cache:{},run_target:2})")
    listing["value"] = LIST.replace("100.shtml?tracking=one", "300.shtml")
    await parent.reload()
    bonus_option = parent.get_by_role("checkbox", name="允许追加加分项消息", exact=True)
    await expect(bonus_option).not_to_be_checked()
    auto_option = parent.get_by_role("checkbox", name="自动发送加分项消息", exact=True)
    await expect(auto_option).to_be_disabled()
    await expect(auto_option).not_to_be_checked()
    await bonus_option.check()
    await expect(bonus_option).to_be_checked()
    for _ in range(40):
        if await worker.evaluate("async () => (await chrome.storage.local.get('allow_bonus_message')).allow_bonus_message"):
            break
        await asyncio.sleep(0.05)
    await parent.reload()
    await expect(bonus_option).to_be_checked()
    if auto_send:
        await auto_option.check()
        await parent.reload()
        await expect(auto_option).to_be_checked()
    await parent.screenshot(path=str(ART / ("bonus-checkbox-auto.png" if auto_send else "bonus-checkbox.png")))
    async with ctx.expect_page() as opened:
        await parent.get_by_role("button", name="开始", exact=True).click()
    bonus_child = await opened.value
    drafted = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed" and not s.get("liepin_task"))
    draft_text = "加分项也涉及，包括production AI agents等。"
    if auto_send:
        assert bonus_child.is_closed(), "confirmed bonus send must close its owned detail tab"
        assert not [page for page in ctx.pages if "/a/300.shtml" in page.url]
    else:
        await expect(bonus_child.locator("textarea")).to_have_value(draft_text)
        assert await bonus_child.evaluate("window.sendClicks||0") == 0
        assert await bonus_child.evaluate("window.clicks") == 1
    assert drafted["run"]["applications"]["liepin:a:300"]["bonus_draft"]["status"] == ("sent" if auto_send else "prepared")
    assert drafted["run"]["applications"]["liepin:a:102"]["status"] == "contact_opened"
    assert not drafted["run"].get("bonus_review")
    tabs = await worker.evaluate("()=>chrome.tabs.query({url:'https://c.liepin.com/*'})")
    assert tabs[0]["active"], "retained draft must return focus to the list"
    if auto_send:
        await parent.screenshot(path=str(ART / "bonus-sent-tab-closed.png"))
    else:
        assert not bonus_child.is_closed()
        await bonus_child.screenshot(path=str(ART / "bonus-draft-unsent.png"))
        await parent.bring_to_front()
        await parent.reload()
        await expect(bonus_child.locator("textarea")).to_have_value(draft_text)
        assert await bonus_child.evaluate("window.sendClicks||0") == 0
        await bonus_child.close()
    if auto_send: await auto_option.uncheck()
    await bonus_option.uncheck()
    await expect(bonus_option).not_to_be_checked()
    await worker.evaluate("()=>chrome.storage.local.set({run_target:1,allow_bonus_message:false})")


async def main():
    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    env = dict(
        os.environ,
        JSEEKER_PORT="17483",
        JSEEKER_TOKEN="liepin-fixture-token",
        OPENAI_BASE_URL=f"http://127.0.0.1:{model.server_port}/v1",
        OPENAI_MODEL="fixture-fast",
        OPENAI_API_KEY="fixture-key",
        JSEEKER_JD_LOG_PATH=str(ART / "jd-items.jsonl"),
    )
    helper = await asyncio.create_subprocess_exec(
        "node",
        "helper/server.mjs",
        cwd=ROOT,
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )

    async def wait_state(worker, predicate, timeout=25):
        for _ in range(timeout * 10):
            state = await worker.evaluate(
                "()=>chrome.storage.local.get(['run','liepin_task','contacted_jobs'])"
            )
            if predicate(state):
                return state
            await asyncio.sleep(0.1)
        raise AssertionError(
            f"timed out: run={state.get('run', {}).get('status')} reason={state.get('run', {}).get('stop_reason')} task={state.get('liepin_task')}"
        )

    try:
        async with async_playwright() as p:
            with tempfile.TemporaryDirectory(
                prefix="jseeker-liepin-fixture-"
            ) as profile:
                ctx = await p.chromium.launch_persistent_context(
                    profile,
                    channel="chromium",
                    headless=True,
                    viewport={"width": 1440, "height": 1000},
                    args=[
                        f"--disable-extensions-except={ROOT / 'dist'}",
                        f"--load-extension={ROOT / 'dist'}",
                    ],
                )
                mode = {"value": "normal"}
                listing = {"value": LIST}
                await ctx.route(
                    "https://c.liepin.com/**",
                    lambda route: route.fulfill(content_type="text/html", body=listing["value"]),
                )
                await ctx.route(
                    re.compile(r"https://www\.liepin\.com/(a|job)/\d+\.shtml.*"),
                    lambda route: route.fulfill(
                        content_type="text/html",
                        body=detail(
                            re.search(r"/(\d+)\.shtml", route.request.url)[1],
                            mode["value"],
                        ),
                    ),
                )
                worker = (
                    ctx.service_workers[0]
                    if ctx.service_workers
                    else await ctx.wait_for_event("serviceworker")
                )
                options = await ctx.new_page()
                await options.goto(
                    f"chrome-extension://{worker.url.split('/')[2]}/options.html"
                )
                await options.wait_for_load_state()
                await options.evaluate(
                    "()=>chrome.runtime.sendMessage({type:'GET_STATE'})"
                )
                await worker.evaluate(
                    """async () => { await chrome.storage.local.set({helper_port:17483, helper_token_persisted:'liepin-fixture-token', run_target:1, match_threshold:80, selected_cities:['深圳'], llm_model:'fixture-fast', llm_base_url:'', profile:{version:'fixture-cv',text:'I build production AI agents and lead engineering teams.'}}); }"""
                )
                parent = await ctx.new_page()
                await parent.goto("https://c.liepin.com/?time=1")
                await expect(parent.locator("#jseeker-root")).to_contain_text("LIEPIN")
                if os.environ.get("JSEEKER_LIEPIN_BONUS_ONLY") == "1":
                    await verify_liepin_bonus(ctx, worker, parent, listing, wait_state)
                    await verify_liepin_bonus(ctx, worker, parent, listing, wait_state, auto_send=True)
                    print("Liepin bonus browser passed: next job completed, list active; draft-only and opt-in auto-send both verified")
                    await ctx.close()
                    return
                # Slow typing must retain focus across autosave and unrelated renders.
                count = parent.get_by_role("spinbutton", name="运行数量", exact=True)
                await count.fill("")
                await count.press("1")
                await expect(parent.locator("#jseeker-root")).to_contain_text("saved")
                await parent.wait_for_timeout(600)
                await expect(count).to_be_focused()
                await count.press("2")
                await parent.wait_for_timeout(600)
                await expect(count).to_have_value("12")
                await expect(count).to_be_focused()
                await worker.evaluate("""async () => {
                  const tabs = await chrome.tabs.query({url:'https://c.liepin.com/*'});
                  await chrome.tabs.sendMessage(tabs[0].id, {type:'LLM_CONFIG_CHANGED',status:{configured:true}});
                }""")
                await expect(count).to_be_focused()
                await count.press("3")
                await parent.wait_for_timeout(600)
                await expect(count).to_have_value("123")
                assert await worker.evaluate("async () => (await chrome.storage.local.get('run_target')).run_target") == 123
                await parent.reload()
                await expect(count).to_have_value("123")
                await parent.screenshot(path=str(ART / "run-count-123.png"))
                await count.fill("1")
                await parent.wait_for_timeout(600)
                # A paused title request must release the UI before the provider replies.
                await worker.evaluate("()=>chrome.storage.local.set({title_screen_enabled:true})")
                SCREEN_ENTERED.clear()
                SCREEN_RELEASE.clear()
                await parent.get_by_role("button", name="开始", exact=True).click()
                for _ in range(100):
                    if SCREEN_ENTERED.is_set():
                        break
                    await asyncio.sleep(0.05)
                assert SCREEN_ENTERED.is_set()
                await parent.get_by_role("button", name="暂停", exact=True).click()
                await expect(parent.get_by_role("button", name="开始", exact=True)).to_be_visible(timeout=2000)
                assert not SCREEN_RELEASE.is_set()
                cancelled_screen = await worker.evaluate("() => chrome.storage.local.get(['run','liepin_task'])")
                assert cancelled_screen["run"]["status"] == "paused"
                assert cancelled_screen["liepin_task"] is None
                SCREEN_RELEASE.set()
                await worker.evaluate("()=>chrome.storage.local.set({title_screen_enabled:false})")
                await parent.get_by_role("button", name="新批次", exact=True).click()
                # Simulate a delayed handoff: wait visibly, then resume automatically.
                cdp = await ctx.new_cdp_session(parent)
                worlds = []
                cdp.on("Runtime.executionContextCreated", lambda event: worlds.append(event["context"]))
                await cdp.send("Runtime.enable")
                extension_world = next(world["id"] for world in worlds if world.get("origin", "").startswith("chrome-extension://"))
                await cdp.send("Runtime.evaluate", {"contextId": extension_world, "expression": "window.fixtureHidden=true;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden,configurable:true})"})
                await parent.get_by_role("button", name="开始", exact=True).click()
                await expect(parent.locator("#jseeker-root")).to_contain_text("WAITING / 等待前台")
                await parent.wait_for_timeout(2500)
                await expect(parent.get_by_role("button", name="暂停", exact=True)).to_be_visible()
                await parent.screenshot(path=str(ART / "waiting-visible.png"))
                await cdp.send("Runtime.evaluate", {"contextId": extension_world, "expression": "window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))"})
                done = await wait_state(
                    worker, lambda s: (s.get("run") or {}).get("status") == "completed"
                )
                assert len(done["run"]["jobs"]) == 3, done
                assert (
                    done["run"]["applications"]["liepin:a:100"]["status"]
                    == "below_threshold"
                )
                assert (
                    done["run"]["applications"]["liepin:a:101"]["status"]
                    == "already_contacted"
                )
                assert (
                    done["run"]["applications"]["liepin:a:102"]["status"]
                    == "contact_opened"
                )
                assert done["liepin_task"] is None
                assert sum("/a/" in page.url for page in ctx.pages) == 0
                await parent.screenshot(path=str(ART / "fixture-completed.png"))
                # Refresh + changed tracking parameters keep the same run and IDs.
                run_id = done["run"]["id"]
                await parent.reload()
                await expect(parent.locator("#jseeker-root")).to_contain_text("1/1")
                await parent.get_by_role("button", name="开始", exact=True).click()
                same = await wait_state(
                    worker, lambda s: (s.get("run") or {}).get("status") == "completed"
                )
                assert same["run"]["id"] == run_id and len(same["run"]["jobs"]) == 3
                # New batch preserves history and exhausts instead of re-contacting.
                await parent.get_by_role("button", name="新批次", exact=True).click()
                await parent.get_by_role("button", name="开始", exact=True).click()
                await wait_state(
                    worker,
                    lambda s: (s.get("run") or {}).get("status") == "exhausted",
                    timeout=25,
                )
                # One genuine unknown requirement is quarantined; the next
                # eligible job still completes the batch without another Start.
                await worker.evaluate("()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},evaluation_cache:{}})")
                listing["value"] = LIST.replace("100.shtml?tracking=one", "200.shtml").replace("101.shtml", "201.shtml")
                await parent.reload()
                await parent.get_by_role("button", name="开始", exact=True).click()
                reviewed = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
                assert reviewed["run"]["applications"]["liepin:a:200"]["status"] == "review_required"
                assert "liepin:a:200" not in reviewed.get("contacted_jobs", {})
                assert reviewed["run"]["applications"]["liepin:a:201"]["status"] == "contact_opened"
                assert reviewed["run"]["scores"]["liepin:a:201"]["requirements_status"] == "met"
                assert len(reviewed["run"]["jobs"]) == 2
                await parent.screenshot(path=str(ART / "review-skipped-continues.png"))
                await verify_liepin_bonus(ctx, worker, parent, listing, wait_state)
                # Refresh the list while the model is pending. Recovery reuses
                # the detail and resumes automatically, with no second click.
                await worker.evaluate("()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},evaluation_cache:{}})")
                listing["value"] = LIST
                MODEL_RELEASE.clear()
                await parent.reload()
                await parent.get_by_role("button", name="开始", exact=True).click()
                inflight = await wait_state(worker, lambda s: (s.get("liepin_task") or {}).get("stage") == "scoring")
                pending_child = next(page for page in ctx.pages if "/a/100.shtml" in page.url)
                await parent.reload()
                await expect(parent.locator("#jseeker-root")).to_contain_text("RECOVERING")
                MODEL_RELEASE.set()
                resumed = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
                assert resumed["run"]["id"] == inflight["run"]["id"]
                assert pending_child.is_closed()
                assert len(resumed.get("contacted_jobs", {})) == 2
                assert resumed["run"]["applications"]["liepin:a:102"]["status"] == "contact_opened"
                await parent.screenshot(path=str(ART / "refresh-auto-resumed.png"))
                # Controlled popup, preserve detail; no successful contact record.
                await worker.evaluate(
                    "()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},evaluation_cache:{}})"
                )
                mode["value"] = "popup"
                await parent.reload()
                await parent.get_by_role("button", name="开始", exact=True).click()
                paused = await wait_state(
                    worker,
                    lambda s: (
                        (s.get("liepin_task") or {}).get("contact_clicked")
                        and (s.get("run") or {}).get("stop_reason")
                    ),
                )
                assert paused["run"]["status"] == "paused"
                child = next(page for page in ctx.pages if "/a/102.shtml" in page.url)
                assert await child.evaluate("window.clicks") == 1
                await expect(child.get_by_role("dialog")).to_contain_text("沟通上限")
                await child.screenshot(path=str(ART / "fixture-popup-paused.png"))
                assert "liepin:a:102" not in paused.get("contacted_jobs", {})
                assert any(
                    item["job"].get("site") == "liepin" and item["profile"]["text"]
                    for item in SEEN_INPUTS
                )
                # Restart the actual MV3 extension, then recover the persisted
                # task without opening a second detail or resending an uncertain contact.
                await child.get_by_role("dialog").evaluate("node=>node.remove()")
                old_worker = worker
                async with ctx.expect_event("serviceworker") as restarted:
                    try:
                        await old_worker.evaluate("()=>chrome.runtime.reload()")
                    except Exception:
                        pass  # The execution context is intentionally destroyed.
                worker = await restarted.value
                options = await ctx.new_page()
                await options.goto(
                    f"chrome-extension://{worker.url.split('/')[2]}/options.html"
                )
                await options.evaluate(
                    "()=>chrome.runtime.sendMessage({type:'GET_STATE'})"
                )
                await parent.bring_to_front()
                await parent.reload()
                await expect(parent.locator("#jseeker-root")).to_contain_text("PAUSED")
                await parent.get_by_role("button", name="开始", exact=True).click()
                recovered = await wait_state(
                    worker,
                    lambda s: (
                        "此前沟通结果未确认"
                        in ((s.get("run") or {}).get("stop_reason") or "")
                    ),
                )
                assert recovered["run"]["status"] == "paused"
                assert await child.evaluate("window.clicks") == 1
                assert sum("/a/102.shtml" in page.url for page in ctx.pages) == 1
                await child.close()
                await wait_state(
                    worker,
                    lambda s: (
                        "标签页已关闭"
                        in ((s.get("run") or {}).get("stop_reason") or "")
                    ),
                )
                logged = [
                    json.loads(line)
                    for line in (ART / "jd-items.jsonl").read_text().splitlines()
                ]
                assert any(
                    row.get("site") == "liepin"
                    and row.get("job_id") == "liepin:a:102"
                    and row.get("url") == "https://www.liepin.com/a/102.shtml"
                    for row in logged
                )
                # A list-page promotion appearing during detail scoring must
                # cancel the task before it can contact or open another JD.
                await worker.evaluate(
                    "()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},evaluation_cache:{}})"
                )
                mode["value"] = "normal"
                MODEL_RELEASE.clear()
                await parent.bring_to_front()
                await parent.reload()
                await parent.get_by_role("button", name="开始", exact=True).click()
                await wait_state(
                    worker,
                    lambda s: (s.get("liepin_task") or {}).get("stage") == "scoring",
                )
                await parent.evaluate(
                    """() => document.body.insertAdjacentHTML('beforeend', '<div class="adslots vapAdModal--fixture" style="position:fixed;inset:0;background:#0008">推广弹窗</div>')"""
                )
                await wait_state(
                    worker,
                    lambda s: (
                        (s.get("liepin_task") or {}).get("cancelled")
                        and (s.get("run") or {}).get("status") == "paused"
                    ),
                )
                MODEL_RELEASE.set()
                await expect(
                    parent.get_by_role("button", name="开始", exact=True)
                ).to_be_enabled()
                promo_state = await worker.evaluate(
                    "()=>chrome.storage.local.get(['run','contacted_jobs'])"
                )
                assert not promo_state.get("contacted_jobs")
                assert len(promo_state["run"]["jobs"]) == 1
                # BOSS uses the same visibility behavior, including manual pause.
                # Wait for the cancelled inference to leave the coordinator before
                # switching sites; direct storage writes bypass its mutation queue.
                for _ in range(100):
                    reset = await options.evaluate("() => chrome.runtime.sendMessage({type:'NEW_RUN'})")
                    if reset.get("ok"):
                        break
                    await asyncio.sleep(0.05)
                assert reset.get("ok"), reset
                await parent.close()
                for child in list(ctx.pages):
                    if "/a/" in child.url:
                        await child.close()
                await worker.evaluate("""() => chrome.storage.local.set({
                  run:null,lease:null,liepin_task:null,job_index:{},contacted_jobs:{},
                  evaluation_cache:{},run_target:1,selected_cities:['深圳','上海']
                })""")
                boss_fixture = (ROOT / "tests/fixture.html").read_text().replace("n<=35", "n<=1")
                boss_listing = {"value": boss_fixture}
                await ctx.route("https://www.zhipin.com/**", lambda route: route.fulfill(content_type="text/html", body=boss_fixture_response(route.request.url, boss_listing)))
                boss_page = await ctx.new_page()
                await boss_page.goto("https://www.zhipin.com/web/geek/jobs?city=101280600")
                await expect(boss_page.locator("#jseeker-root")).to_contain_text("BOSS")
                await expect(boss_page.get_by_role("checkbox", name="允许追加加分项消息", exact=True)).to_be_visible()
                boss_cdp = await ctx.new_cdp_session(boss_page)
                boss_worlds = []
                boss_cdp.on("Runtime.executionContextCreated", lambda event: boss_worlds.append(event["context"]))
                await boss_cdp.send("Runtime.enable")
                boss_world = next(world["id"] for world in boss_worlds if world.get("origin", "").startswith("chrome-extension://"))
                await boss_cdp.send("Runtime.evaluate", {"contextId":boss_world,"expression":"window.fixtureHidden=true;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden,configurable:true})"})
                await boss_page.get_by_role("button", name="开始", exact=True).click()
                await expect(boss_page.locator("#jseeker-root")).to_contain_text("WAITING / 等待前台")
                await boss_page.get_by_role("button", name="暂停", exact=True).click()
                await expect(boss_page.get_by_role("button", name="开始", exact=True)).to_be_visible()
                assert await boss_page.evaluate("fixture.showCalls.length") == 1  # initial fixture detail only
                await boss_page.get_by_role("button", name="开始", exact=True).click()
                await expect(boss_page.locator("#jseeker-root")).to_contain_text("WAITING / 等待前台")
                await boss_page.wait_for_timeout(2500)
                await boss_page.screenshot(path=str(ART / "boss-waiting-visible.png"))
                await boss_cdp.send("Runtime.evaluate", {"contextId":boss_world,"expression":"window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))"})
                boss_done = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
                assert len(boss_done["run"]["jobs"]) == 1
                assert await boss_page.evaluate("fixture.chatClicks") == 1
                await boss_page.screenshot(path=str(ART / "boss-resumed-completed.png"))
                await verify_boss_bonus(ctx, worker, boss_page, boss_listing, boss_fixture, wait_state)
                (ART / "fixture-result.json").write_text(
                    json.dumps(
                        {
                            "status": "passed",
                            "scenarios": [
                                "slow-run-count-input-and-refresh-123",
                                "delayed-visibility-handoff",
                                "pause-aborts-slow-title-request",
                                "boss-hidden-manual-pause-and-auto-resume",
                                "boss-bonus-inline-and-chat-drafts",
                                "boss-bonus-preserves-list-with-separate-chat-tab",
                                "boss-bonus-exact-contact-selection-and-saved-draft",
                                "boss-bonus-wrong-job-and-unowned-chat-refused",
                                "boss-bonus-unsent-draft-automatically-continues",
                                "domain-routing",
                                "new-tab",
                                "below-threshold-continue",
                                "already-contacted",
                                "qualified-contact",
                                "owned-close-return",
                                "refresh-dedup",
                                "unknown-requirement-skips-and-continues",
                                "invented-requirement-cannot-block",
                                "refresh-during-scoring-auto-resumes",
                                "history-exhaustion",
                                "popup-pause",
                                "extension-restart-recovery",
                                "manual-detail-close",
                                "jsonl-log",
                                "parent-promotion-pauses-scoring",
                            ],
                            "real_contacts": 0,
                            "simulated": True,
                        },
                        indent=2,
                    )
                )
                print("Liepin/BOSS robustness fixture E2E passed; artifacts:", ART)
                await ctx.close()
    finally:
        SCREEN_RELEASE.set()
        MODEL_RELEASE.set()
        helper.terminate()
        await helper.wait()
        model.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
