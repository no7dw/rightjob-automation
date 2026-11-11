"""Both sites roll over changed scopes automatically; synthetic jobs only."""

import asyncio
import json
import os
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright, expect
from liepin_flow_browser_test import LIST, detail

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts/scope"
ART.mkdir(parents=True, exist_ok=True)
RELEASE = threading.Event()
ENTERED = threading.Event()
RELEASE.set()


class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        ENTERED.set()
        RELEASE.wait(timeout=20)
        body = json.dumps({"choices": [{"message": {"content": json.dumps({
            "match_score": 95, "verdict": "apply", "requirements": [],
        })}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


async def stored(worker, predicate, timeout=30):
    for _ in range(timeout * 10):
        state = await worker.evaluate("()=>chrome.storage.local.get(['run','archives','lease','liepin_task','contacted_jobs','job_index'])")
        if predicate(state):
            return state
        await asyncio.sleep(0.1)
    raise AssertionError(f"scope fixture timed out: {state}")


async def change_scope(page, site):
    if site == "boss":
        await page.locator(".search-condition").evaluate("e=>e.textContent='新搜索范围'")
    else:
        await page.get_by_placeholder("搜索职位、公司").fill("新搜索范围")


async def wait_model():
    for _ in range(150):
        if ENTERED.is_set():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("scoring never started")


async def verify_site(ctx, worker, site):
    page = await ctx.new_page()
    url = "https://www.zhipin.com/web/geek/jobs" if site == "boss" else "https://c.liepin.com/"
    first_id = "job1" if site == "boss" else "liepin:a:102"
    old_scope = {"url": url, "filters": "old", **({"site": site} if site == "liepin" else {})}
    old_run = {"id": "old-run", "scope": old_scope, "status": "paused", "target": 1,
        "jobs": [], "scores": {}, "applications": {}, "attempts": [], "seen": []}
    history = {first_id: {"job_id": first_id, "status": "contact_opened"}}

    async def reset(run=None, contacts=None):
        RELEASE.set()
        await worker.evaluate("patch=>chrome.storage.local.set(patch)", {
            "run": run, "lease": None, "liepin_task": None, "archives": [],
            "contacted_jobs": contacts or {}, "job_index": {}, "evaluation_cache": {},
            "run_target": 1, "allow_bonus_message": False, "auto_send_bonus_message": False,
        })
        if page.url == url:
            await page.reload()
        else:
            await page.goto(url)
        await page.bring_to_front()
        await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled()

    # A stored checkpoint from another scope needs only Start, not New Batch.
    await reset(old_run, history)
    await page.get_by_role("button", name="开始", exact=True).click()
    if site == "boss":
        await expect(page.locator('#jseeker-root')).to_contain_text('BOSS 筛选范围与当前批次不同')
        unchanged = await stored(worker, lambda s: True)
        assert unchanged['run']['id'] == old_run['id'] and not unchanged['archives']
        await page.get_by_role('button', name='新批次', exact=True).click()
        await page.get_by_role('button', name='开始', exact=True).click()
    done = await stored(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
    assert done["run"]["id"] != old_run["id"]
    assert len(done["archives"]) == 1 and done["archives"][0]["id"] == old_run["id"]
    assert done["contacted_jobs"][first_id] == history[first_id]
    assert all(job["job_id"] != first_id for job in done["run"]["jobs"])
    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled()
    run_id = done["run"]["id"]
    await page.get_by_role("button", name="开始", exact=True).click()
    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled()
    unchanged = await stored(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
    assert unchanged["run"]["id"] == run_id and len(unchanged["archives"]) == 1
    print(f"{site}: stale scope {'required manual New Batch' if site == 'boss' else 'automatically replaced'}, dedup and same-scope resume passed", flush=True)

    # Change the scope during scoring; the old job cannot be contacted.
    await reset()
    ENTERED.clear()
    RELEASE.clear()
    await page.get_by_role("button", name="开始", exact=True).click()
    await wait_model()
    scoring = await stored(worker, lambda s: bool((s.get("run") or {}).get("jobs")))
    previous_id = scoring["run"]["id"]
    await change_scope(page, site)
    RELEASE.set()
    if site == "boss":
        await expect(page.get_by_role('button', name='开始', exact=True)).to_be_enabled()
        await expect(page.locator('#jseeker-root')).to_contain_text('BOSS 筛选范围已变化')
        stopped = await stored(worker, lambda s: True)
        assert stopped['run']['id'] == previous_id and not stopped['archives']
        assert first_id not in stopped['contacted_jobs']
        await page.get_by_role('button', name='新批次', exact=True).click()
        await page.get_by_role('button', name='开始', exact=True).click()
    done = await stored(worker, lambda s: (s.get("run") or {}).get("id") != previous_id and (s.get("run") or {}).get("status") == "completed")
    assert len(done["archives"]) == 1 and done["archives"][0]["id"] == previous_id
    assert first_id not in done["contacted_jobs"]
    assert first_id in done["job_index"], "the completed old score must remain reusable"
    assert done["job_index"][first_id]["score_status"] == "valid"
    assert (done["run"]["scope"].get("query") == "新搜索范围" if site == "liepin"
        else done["run"]["scope"]["filters"] == "新搜索范围")
    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled()
    await page.screenshot(path=str(ART / f"{site}-auto-rollover.png"))
    print(f"{site}: scope change protected old job; {'manual restart required' if site == 'boss' else 'automatic rollover passed'}", flush=True)

    # Manual pause still wins even when the search changes at the same time.
    await reset()
    ENTERED.clear()
    RELEASE.clear()
    await page.get_by_role("button", name="开始", exact=True).click()
    await wait_model()
    await page.bring_to_front()
    await page.get_by_role("button", name="暂停", exact=True).click()
    await change_scope(page, site)
    RELEASE.set()
    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled(timeout=15000)
    paused = await stored(worker, lambda s: not s.get("archives"))
    await asyncio.sleep(0.5)
    assert not paused["contacted_jobs"] and not paused["archives"]
    assert not (await stored(worker, lambda s: True))["archives"]
    print(f"{site}: user pause preserved", flush=True)

    # A verification dialog prevents any automatic batch or contact.
    await reset(old_run, history)
    await page.evaluate("()=>document.body.insertAdjacentHTML('beforeend','<div class=login-dialog role=dialog>请完成验证</div>')")
    await page.get_by_role("button", name="开始", exact=True).click()
    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_enabled()
    blocked = await stored(worker, lambda s: True)
    assert blocked["run"]["id"] == old_run["id"] and not blocked["archives"]
    assert blocked["contacted_jobs"] == history
    print(f"{site}: verification block preserved", flush=True)
    # Reset the shared profile before closing this site and testing the next.
    await worker.evaluate("()=>chrome.storage.local.set({run:null,lease:null,liepin_task:null})")
    await page.close()
    for child in list(ctx.pages):
        if re.search(r"/a/\d+\.shtml", child.url):
            await child.close()


async def main():
    model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    helper = await asyncio.create_subprocess_exec("node", "helper/server.mjs", cwd=ROOT,
        env={**os.environ, "JSEEKER_PORT": "17486", "JSEEKER_TOKEN": "scope-test-token",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1",
            "OPENAI_MODEL": "fixture-scope", "OPENAI_API_KEY": "fixture-key",
            "JSEEKER_JD_LOG_PATH": str(ART / "jd-items.jsonl")},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        await asyncio.wait_for(helper.stdout.readline(), 8)
        async with async_playwright() as p:
            with tempfile.TemporaryDirectory(prefix="jseeker-scope-") as profile:
                ctx = await p.chromium.launch_persistent_context(profile, channel="chromium", headless=True,
                    viewport={"width": 1440, "height": 1000}, args=[
                        f"--disable-extensions-except={ROOT / 'dist'}", f"--load-extension={ROOT / 'dist'}"])
                boss_html = (ROOT / "tests/fixture.html").read_text().replace("n<=35", "n<=2").replace("-K", "30-50K·13薪")
                liepin_html = LIST.replace("100.shtml?tracking=one", "102.shtml").replace("101.shtml", "103.shtml").replace('<div class="card"><a target="_blank" href="https://www.liepin.com/a/102.shtml">Agent总监【深圳】</a><span>50-80k</span></div>', '')
                await ctx.route("https://www.zhipin.com/**", lambda route: route.fulfill(content_type="text/html", body=boss_html))
                await ctx.route("https://c.liepin.com/**", lambda route: route.fulfill(content_type="text/html", body=liepin_html))
                await ctx.route(re.compile(r"https://www\.liepin\.com/(a|job)/\d+\.shtml.*"), lambda route: route.fulfill(
                    content_type="text/html", body=detail(re.search(r"/(\d+)\.shtml", route.request.url)[1])))
                worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
                options = await ctx.new_page()
                await options.goto(f"chrome-extension://{worker.url.split('/')[2]}/options.html")
                await options.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                await worker.evaluate("()=>chrome.storage.local.set({helper_port:17486,helper_token_persisted:'scope-test-token',match_threshold:80,selected_cities:['深圳','上海'],llm_model:'fixture-scope',llm_base_url:'',profile:{version:'fixture-cv',text:'I build production AI agents and lead engineering teams.'}})")
                await verify_site(ctx, worker, "boss")
                await verify_site(ctx, worker, "liepin")
                await ctx.close()
    finally:
        RELEASE.set()
        helper.terminate()
        await helper.wait()
        model.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
