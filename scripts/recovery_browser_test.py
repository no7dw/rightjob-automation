"""Verify the PLAN1 retry-failure path after a wrong job-detail identity."""

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
ART.mkdir(exist_ok=True)


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "match_score": 91,
                                "verdict": "apply",
                                "summary": "Retry flow fixture match",
                                "strengths": ["Agent"],
                                "gaps": [],
                                "evidence": [],
                            }
                        )
                    }
                }
            ]
        }
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


async def main():
    model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    token = "plan1-retry-token"
    helper_port = 17475
    helper = await asyncio.create_subprocess_exec(
        "node",
        "helper/server.mjs",
        cwd=ROOT,
        env={
            **os.environ,
            "JSEEKER_PORT": str(helper_port),
            "JSEEKER_TOKEN": token,
            "OPENAI_API_KEY": "plan1-retry-secret",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{model.server_address[1]}/v1",
            "OPENAI_MODEL": "plan1-retry-model",
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        startup = await asyncio.wait_for(helper.stdout.readline(), 8)
        assert f"127.0.0.1:{helper_port}".encode() in startup
        with tempfile.TemporaryDirectory(prefix="jseeker-plan1-retry-") as profile:
            async with async_playwright() as playwright:
                context = await playwright.chromium.launch_persistent_context(
                    profile,
                    channel="chromium",
                    headless=True,
                    viewport={"width": 1440, "height": 1000},
                    args=[
                        f"--disable-extensions-except={ROOT / 'dist'}",
                        f"--load-extension={ROOT / 'dist'}",
                    ],
                )
                await context.route(
                    "https://www.zhipin.com/**",
                    lambda route: route.fulfill(
                        content_type="text/html",
                        body=(ROOT / "tests/fixture.html").read_text(),
                    ),
                )
                worker = (
                    context.service_workers[0]
                    if context.service_workers
                    else await context.wait_for_event("serviceworker")
                )
                extension_id = worker.url.split("/")[2]
                options = await context.new_page()
                await options.goto(
                    f"chrome-extension://{extension_id}/options.html"
                )
                await options.evaluate(
                    "async port => chrome.storage.local.set({helper_port: port})",
                    helper_port,
                )
                await options.locator("details").evaluate(
                    "node => node.open = true"
                )
                await options.locator("#token").fill(token)
                await options.get_by_role(
                    "button",
                    name="保存连接 Token",
                    exact=True,
                ).click()
                await expect(options.locator("#llm-status")).to_contain_text(
                    "LLM      已配置"
                )
                page = await context.new_page()
                await page.goto("https://www.zhipin.com/web/geek/jobs")
                await page.wait_for_selector("#jseeker-root", state="attached")
                await page.wait_for_selector(".more-job-btn")
                await page.get_by_label("运行数量", exact=True).fill("1")
                for _ in range(40):
                    target = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run_target')).run_target"
                    )
                    if target == 1:
                        break
                    await asyncio.sleep(0.1)
                assert target == 1
                await page.evaluate("window.fixture.mismatch=true")
                await page.get_by_role("button", name="开始", exact=True).click()
                run = None
                for _ in range(220):
                    run = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run')).run"
                    )
                    if run and run.get("attempts"):
                        break
                    await asyncio.sleep(0.1)
                assert run and run["attempts"][0]["status"] == "failed"
                assert not run["jobs"]
                # A failure no longer satisfies the match target. Pause explicitly
                # before testing a user-requested retry of that same item.
                await page.get_by_role("button", name="暂停", exact=True).click()
                for _ in range(500):
                    panel_text = await page.locator("#jseeker-root").evaluate(
                        "node => node.shadowRoot.querySelector('.body').innerText"
                    )
                    if "FAILED  1" in panel_text and "开始" in panel_text:
                        break
                    await asyncio.sleep(0.1)
                assert "FAILED  1" in panel_text, panel_text
                assert "开始" in panel_text, panel_text
                await page.screenshot(
                    path=str(ART / "plan1-retry-failed.png"),
                    full_page=True,
                )
                await expect(
                    page.get_by_role("button", name="开始", exact=True)
                ).to_be_enabled(timeout=15000)
                await expect(
                    page.get_by_role("button", name="重试失败", exact=True)
                ).to_be_enabled(timeout=15000)
                await page.evaluate("window.fixture.mismatch=false")
                await page.get_by_role(
                    "button", name="重试失败", exact=True
                ).click()
                for _ in range(300):
                    state = await worker.evaluate(
                        "async()=> await chrome.storage.local.get(['run','contacted_jobs'])"
                    )
                    run = state.get("run")
                    if (
                        run
                        and run.get("scores", {}).get("job1")
                        and state.get("contacted_jobs", {})
                        .get("job1", {})
                        .get("status")
                        == "contact_opened"
                    ):
                        break
                    await asyncio.sleep(0.1)
                assert [job["job_id"] for job in run["jobs"]] == ["job1"]
                assert run["retry_epochs"]["job1"] == 1
                assert run["attempts"][0]["status"] == "failed"
                assert run["scores"]["job1"]["match_score"] == 91
                assert state["contacted_jobs"]["job1"]["status"] == "contact_opened"
                assert await page.evaluate("window.fixture.cityPopups") == 1
                assert await page.evaluate("window.fixture.cityClicks") == 1
                assert await page.evaluate("window.fixture.chatClicks") == 1
                assert await page.evaluate("window.fixture.defaultClicks") == 0
                assert await page.evaluate("window.fixture.dismissedDialogs") == 1
                await page.screenshot(
                    path=str(ART / "plan1-retry.png"),
                    full_page=True,
                )
                report = {
                    "status": "passed",
                    "checks": [
                        "wrong-ID failure recorded without false JD",
                        "retry button resets failure epoch",
                        "successful retry preserves failure history",
                        "retry scores and enters application once",
                    ],
                    "attempts": len(run["attempts"]),
                }
                (ART / "plan1-retry-report.json").write_text(
                    json.dumps(report, ensure_ascii=False, indent=2)
                )
                print(json.dumps(report, ensure_ascii=False))
                await context.close()
    finally:
        if helper.returncode is None:
            helper.terminate()
        await helper.wait()
        model.shutdown()
        model.server_close()


asyncio.run(main())
