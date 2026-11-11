"""Verify that the production extension passively captures at most ten user-selected jobs."""

import asyncio
import json
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
ART.mkdir(exist_ok=True)


async def main():
    async with async_playwright() as playwright:
        with tempfile.TemporaryDirectory(prefix="jseeker-passive-") as profile:
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
            page = await context.new_page()
            downloads = []
            page.on("download", lambda download: downloads.append(download))
            await page.goto("https://www.zhipin.com/web/geek/jobs")
            await page.wait_for_selector("#jseeker-root", state="attached")
            await page.wait_for_selector(".more-job-btn")
            await worker.evaluate(
                "async()=>{const [tab]=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});return chrome.tabs.sendMessage(tab.id,{type:'TOGGLE'});}"
            )
            await page.get_by_label("可见薪资乱码时使用本地截图 OCR").uncheck()
            before = await page.evaluate(
                "({scroll:document.querySelector('.job-list-container').scrollTop,calls:[...window.fixture.showCalls]})"
            )
            assert before["calls"] == ["job1"]
            await page.screenshot(path=str(ART / "passive-controls.png"), full_page=True)
            await page.get_by_role("button", name="安静试运行10条").click()

            async def wait_jobs(count):
                for _ in range(80):
                    run = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run')).run"
                    )
                    if run and len(run["jobs"]) >= count:
                        return run
                    await asyncio.sleep(0.1)
                raise AssertionError(f"timed out waiting for {count} passive jobs")

            run = await wait_jobs(1)
            after_start = await page.evaluate(
                "({scroll:document.querySelector('.job-list-container').scrollTop,calls:[...window.fixture.showCalls]})"
            )
            assert after_start == before, "extension changed selection or scroll position"
            assert run["target"] == 10 and run["mode"] == "passive"
            assert await page.locator("#jseeker-root").evaluate(
                "host=>host.shadowRoot.querySelector('.panel').hidden"
            )
            for index in range(1, 10):
                if index == 9:
                    await page.evaluate("window.fixture.emptyJD=true")
                if index == 3:
                    await worker.evaluate(
                        "async()=>{const [tab]=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});return chrome.tabs.sendMessage(tab.id,{type:'TOGGLE'});}"
                    )
                    await page.get_by_role("button", name="暂停", exact=True).click()
                    paused = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run')).run"
                    )
                    assert paused["status"] == "paused" and len(paused["jobs"]) == 3
                    await page.locator(".job-card-box .job-name").nth(index).click()
                    await asyncio.sleep(0.5)
                    paused = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('run')).run"
                    )
                    assert len(paused["jobs"]) == 3
                    await page.get_by_role("button", name="安静试运行10条").click()
                    run = await wait_jobs(index + 1)
                    continue
                await page.locator(".job-card-box .job-name").nth(index).click()
                run = await wait_jobs(index + 1)
            assert run["status"] == "exhausted", run["stop_reason"]
            assert len(run["jobs"]) == 10
            assert sum(job["extraction_status"] == "success" for job in run["jobs"]) == 9
            assert run["jobs"][-1]["extraction_status"] == "partial"
            assert len({job["job_id"] for job in run["jobs"]}) == 10
            assert len(await page.evaluate("window.fixture.showCalls")) == 10
            assert await page.evaluate(
                "window.fixture.chatClicks + window.fixture.likeClicks"
            ) == 0
            assert not downloads
            assert all(job["location_verified"] is False for job in run["jobs"])
            await worker.evaluate(
                "async()=>{const [tab]=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});return chrome.tabs.sendMessage(tab.id,{type:'TOGGLE'});}"
            )
            await page.screenshot(path=str(ART / "passive-results.png"), full_page=True)
            report = {
                "status": "passed",
                "isolated_profile": True,
                "actual_boss_automated": False,
                "selected_by_user": 10,
                "complete": 9,
                "partial": 1,
                "extension_clicks_or_scrolls": 0,
                "downloads": 0,
            }
            (ART / "passive-browser-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2)
            )
            print(json.dumps(report, ensure_ascii=False))
            await context.close()


asyncio.run(main())
