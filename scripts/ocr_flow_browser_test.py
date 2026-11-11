"""Verify PLAN1's automatic local OCR fallback without exposing OCR controls."""

import asyncio
import json
import os
import shutil
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
                                "match_score": 82,
                                "verdict": "apply",
                                "summary": "OCR flow fixture match",
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
    token = "plan1-ocr-token"
    helper_port = 17474
    helper = await asyncio.create_subprocess_exec(
        "node",
        "helper/server.mjs",
        cwd=ROOT,
        env={
            **os.environ,
            "JSEEKER_PORT": str(helper_port),
            "JSEEKER_TOKEN": token,
            "OPENAI_API_KEY": "plan1-ocr-secret",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{model.server_address[1]}/v1",
            "OPENAI_MODEL": "plan1-ocr-model",
            "JSEEKER_OCR_DELAY_MS": "1500",
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        startup = await asyncio.wait_for(helper.stdout.readline(), 8)
        assert f"127.0.0.1:{helper_port}".encode() in startup
        with tempfile.TemporaryDirectory(prefix="jseeker-plan1-ocr-") as temp:
            extension = Path(temp) / "extension"
            shutil.copytree(ROOT / "dist", extension)
            manifest = json.loads((extension / "manifest.json").read_text())
            manifest["host_permissions"].append("<all_urls>")
            (extension / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2)
            )
            async with async_playwright() as playwright:
                context = await playwright.chromium.launch_persistent_context(
                    str(Path(temp) / "profile"),
                    channel="chromium",
                    headless=True,
                    no_viewport=True,
                    args=[
                        "--window-size=1440,1000",
                        f"--disable-extensions-except={extension}",
                        f"--load-extension={extension}",
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
                await page.add_style_tag(
                    content="""
                    .job-salary { font-size: 0 !important; }
                    .job-salary::after {
                      content: "30-50K·13薪";
                      font-size: 14px;
                      color: #ed615b;
                    }
                    """
                )
                await page.get_by_label("运行数量", exact=True).fill("2")
                for _ in range(40):
                    target = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run_target')).run_target"
                    )
                    if target == 2:
                        break
                    await asyncio.sleep(0.1)
                assert target == 2
                await worker.evaluate(
                    "async()=>{const [tab]=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});await chrome.windows.update(tab.windowId,{focused:true});}"
                )
                body_text = await page.locator("#jseeker-root").evaluate(
                    "node => node.shadowRoot.querySelector('.body').innerText"
                )
                assert "OCR" not in body_text
                await page.get_by_role("button", name="开始", exact=True).click()
                run = None
                observed_visible_during_ocr = False
                for _ in range(600):
                    run = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run')).run"
                    )
                    if (
                        run
                        and run.get("pending_evidence")
                        and not any(
                            job.get("ocr_fields")
                            for job in run.get("jobs", [])
                        )
                    ):
                        observed_visible_during_ocr = observed_visible_during_ocr or (
                            await page.locator("#jseeker-root").evaluate(
                                "node => node.style.visibility !== 'hidden'"
                            )
                        )
                    if (
                        run
                        and len(run.get("jobs", [])) >= 2
                        and run.get("scores", {}).get("job2")
                    ):
                        break
                    await asyncio.sleep(0.1)
                assert run and len(run["jobs"]) == 2, run
                assert observed_visible_during_ocr
                job2 = next(job for job in run["jobs"] if job["job_id"] == "job2")
                assert job2["evidence_ids"]
                assert job2["ocr_fields"]["salary"]
                assert "30" in job2["ocr_fields"]["salary"]
                assert "50" in job2["ocr_fields"]["salary"]
                assert "ocr_unavailable" not in job2["quality_flags"], job2.get(
                    "ocr_error"
                )
                assert run["scores"]["job2"]["engine"] == "llm"
                await page.screenshot(
                    path=str(ART / "plan1-ocr.png"),
                    full_page=True,
                )
                report = {
                    "status": "passed",
                    "checks": [
                        "OCR has no visible control",
                        "panel remains visible while local OCR is processing",
                        "PUA salary triggers local screenshot OCR automatically",
                        "OCR text reaches the stored job",
                        "LLM scoring continues after OCR",
                    ],
                    "ocr_salary": job2["ocr_fields"]["salary"],
                }
                (ART / "plan1-ocr-report.json").write_text(
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
