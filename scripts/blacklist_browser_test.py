"""Verify blacklist persistence and skip decisions against synthetic BOSS jobs."""

import asyncio
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"


class ModelHandler(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        ModelHandler.calls += 1
        body = json.dumps({"choices": [{"message": {"content": json.dumps({
            "match_score": 85, "verdict": "apply", "summary": "Fixture score"
        })}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


async def main():
    ART.mkdir(exist_ok=True)
    model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    helper = await asyncio.create_subprocess_exec(
        "node", "helper/server.mjs", cwd=ROOT,
        env={**os.environ, "JSEEKER_PORT": "0", "JSEEKER_TOKEN": "blacklist-test-token",
             "OPENAI_BASE_URL": f"http://127.0.0.1:{model.server_port}/v1",
             "OPENAI_MODEL": "blacklist-fixture", "OPENAI_API_KEY": "fixture-key"},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        port = int((await asyncio.wait_for(helper.stdout.readline(), 8)).decode().strip().rsplit(":", 1)[1])
        browser_options = ({"executable_path": os.environ["JSEEKER_TEST_BROWSER"]}
                           if os.environ.get("JSEEKER_TEST_BROWSER") else {"channel": "chromium"})
        with tempfile.TemporaryDirectory(prefix="jseeker-blacklist-") as profile:
            async with async_playwright() as playwright:
                context = await playwright.chromium.launch_persistent_context(
                    profile, **browser_options, headless=True,
                    viewport={"width": 1440, "height": 1100},
                    args=[f"--disable-extensions-except={ROOT / 'dist'}", f"--load-extension={ROOT / 'dist'}"],
                )
                try:
                    worker = context.service_workers[0] if context.service_workers else await context.wait_for_event("serviceworker")
                    eid = worker.url.split("/")[2]
                    await worker.evaluate("async port => chrome.storage.local.set({helper_port:port,run_target:1,match_threshold:100,selected_cities:['深圳','上海']})", port)
                    options = await context.new_page()
                    await options.goto(f"chrome-extension://{eid}/options.html")
                    await expect(options.locator("#llm-status")).to_contain_text("LLM      已配置")
                    await worker.evaluate("async () => chrome.storage.local.set({run_target:1,match_threshold:100,selected_cities:['深圳','上海']})")
                    fixture = (ROOT / "tests/fixture.html").read_text().replace("n<=35", "n<=3")
                    fixture = fixture.replace("detail.querySelector('#chat').onclick", "if(id==='job1')detail.querySelector('.desc').textContent+=' aAaA ';if(id==='job2')detail.querySelector('.job-name').textContent='BBBB role';detail.querySelector('#chat').onclick")
                    await context.route("https://www.zhipin.com/**", lambda route: route.fulfill(content_type="text/html", body=fixture))
                    page = await context.new_page()
                    await page.goto("https://www.zhipin.com/web/geek/jobs?city=101280600")
                    assert await page.get_by_role("textbox", name="JD 黑名单关键词").count() == 0
                    field = options.get_by_role("textbox", name="JD 黑名单关键词")
                    await field.fill(" aaaa, BBBB，ccc,aaaa ")
                    await field.press("Tab")
                    for _ in range(100):
                        prefs = await worker.evaluate("async () => (await chrome.storage.local.get('prefs')).prefs")
                        if prefs["excluded_terms"] == ["aaaa", "BBBB", "ccc"]:
                            break
                        await asyncio.sleep(0.05)
                    assert prefs["excluded_terms"] == ["aaaa", "BBBB", "ccc"]
                    await options.reload()
                    await expect(field).to_have_value("aaaa,BBBB,ccc")
                    await options.screenshot(path=ART / "blacklist-settings.png", full_page=True)
                    await page.reload()
                    await page.bring_to_front()
                    await page.get_by_role("button", name="开始", exact=True).click()
                    for _ in range(200):
                        run = await worker.evaluate("async () => (await chrome.storage.local.get('run')).run")
                        if run and "job3" in run.get("scores", {}):
                            break
                        await asyncio.sleep(0.1)
                    assert run and len(run["jobs"]) == 3, {
                        "jobs": [job["job_id"] for job in (run or {}).get("jobs", [])],
                        "status": (run or {}).get("status"),
                        "reason": (run or {}).get("stop_reason"),
                        "scores": list((run or {}).get("scores", {})),
                        "errors": await page.locator("#jseeker-root .error").all_text_contents(),
                    }
                    assert set(run["scores"]) == {"job3"}
                    assert ModelHandler.calls == 1
                    assert not run.get("score_failures")
                    assert {job["job_id"]: job.get("blacklist_keyword") for job in run["jobs"]} == {"job1": "aaaa", "job2": "BBBB", "job3": None}
                    assert all(not job.get("evidence_ids") for job in run["jobs"])
                    await expect(page.get_by_role("button", name="开始", exact=True)).to_be_visible()
                    await expect(page.locator("#jseeker-root")).to_contain_text("BLACKLIST SKIPPED  2")
                    await expect(page.locator("#jseeker-root")).to_contain_text("| RUN     1 / 1")
                    progress = page.locator("#jseeker-root pre").filter(has_text="| RUN")
                    progress_text = await progress.text_content()
                    assert "BATCH" not in progress_text
                    assert "| RUN     1 / 1\n| STATE" in progress_text
                    geometry = await progress.evaluate("node => ({height:node.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(node).lineHeight),lines:node.textContent.split('\\n').length})")
                    assert geometry["height"] <= geometry["lineHeight"] * geometry["lines"] + 1
                    assert await page.evaluate("fixture.chatClicks") == 0
                    assert await page.locator(".jseeker-badge").filter(has_text="跳过").count() == 2
                    await page.screenshot(path=ART / "blacklist-sidebar.png", full_page=True)

                    # New blacklist rules also protect previously cached scores.
                    await options.bring_to_front()
                    await field.fill("Python")
                    await field.press("Tab")
                    for _ in range(100):
                        stored = await worker.evaluate("async () => (await chrome.storage.local.get('prefs')).prefs.excluded_terms")
                        if stored == ["Python"]:
                            break
                        await asyncio.sleep(0.05)
                    assert stored == ["Python"]
                    await expect(page.locator("#jseeker-root")).to_contain_text("BLACKLIST SKIPPED  3")
                    score_result = await options.evaluate("async () => chrome.runtime.sendMessage({type:'SCORE',job_id:'job3',engine:'llm'})")
                    assert score_result["ok"] and score_result["data"]["skipped"]
                    contact_result = await options.evaluate("async run_id => chrome.runtime.sendMessage({type:'APPLICATION_RECORD',run_id,job_id:'job3',outcome:'opening',threshold:0})", run["id"])
                    assert not contact_result["ok"] and "黑名单" in contact_result["error"]
                    assert ModelHandler.calls == 1
                    await field.fill("")
                    await field.press("Tab")
                    for _ in range(100):
                        stored = await worker.evaluate("async () => (await chrome.storage.local.get('prefs')).prefs.excluded_terms")
                        if stored == []:
                            break
                        await asyncio.sleep(0.05)
                    assert stored == []
                    await options.reload()
                    await expect(field).to_have_value("")
                    stored_run = await worker.evaluate("async () => (await chrome.storage.local.get('run')).run")
                    assert all("blacklist_keyword" not in job for job in stored_run["jobs"])
                finally:
                    await context.close()
        report = {"status": "passed", "checks": ["settings-only blacklist and persistence", "JD and title skips", "skips avoid OCR and model", "skips do not consume run target", "cached score protected", "backend contact guard", "clear and reload", "saved rules sync to existing sidebar", "compact progress without batch ID or wrapped rows"], "model_calls": ModelHandler.calls, "contact_clicks": 0}
        (ART / "blacklist-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
    finally:
        helper.terminate()
        await helper.wait()
        model.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
