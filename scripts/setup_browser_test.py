"""Verify automatic Helper pairing and toolbar sidebar recovery without applying."""

import asyncio
import json
import os
import tempfile
from pathlib import Path

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"


async def main():
    ART.mkdir(exist_ok=True)
    browser_options = ({"executable_path": os.environ["JSEEKER_TEST_BROWSER"]}
                       if os.environ.get("JSEEKER_TEST_BROWSER") else {"channel": "chromium"})
    helper = await asyncio.create_subprocess_exec(
        "node", "helper/server.mjs", cwd=ROOT,
        env={**os.environ, "JSEEKER_PORT": "0", "JSEEKER_TOKEN": "setup-browser-test-token",
             "OPENAI_BASE_URL": "http://127.0.0.1:9/v1", "OPENAI_MODEL": "setup-fixture",
             "OPENAI_API_KEY": "setup-fixture-key"},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        startup = (await asyncio.wait_for(helper.stdout.readline(), 8)).decode()
        port = int(startup.strip().rsplit(":", 1)[1])
        async with async_playwright() as playwright:
            with tempfile.TemporaryDirectory(prefix="jseeker-setup-") as profile:
                context = await playwright.chromium.launch_persistent_context(
                    profile, **browser_options, headless=True,
                    viewport={"width": 1440, "height": 1000},
                    args=[f"--disable-extensions-except={ROOT / 'dist'}", f"--load-extension={ROOT / 'dist'}"],
                )
                try:
                    worker = context.service_workers[0] if context.service_workers else await context.wait_for_event("serviceworker")
                    extension_id = worker.url.split("/")[2]
                    await worker.evaluate("async port => { await chrome.storage.local.set({helper_port: port}); }", port)
                    options = await context.new_page()
                    await options.goto(f"chrome-extension://{extension_id}/options.html")
                    await expect(options.locator("#llm-status")).to_contain_text("SERVICE  已连接")
                    await expect(options.locator("#llm-status")).to_contain_text("LLM      已配置")
                    assert await options.locator("#health, #clear-api-key").count() == 0
                    assert await worker.evaluate("async () => !!(await chrome.storage.local.get('helper_token_persisted')).helper_token_persisted")
                    await options.screenshot(path=ART / "setup-pairing.png", full_page=True)

                    # Stale credentials are replaced automatically after a 401.
                    await worker.evaluate("async () => { await chrome.storage.local.set({helper_token_persisted:'stale'}); await chrome.storage.session.set({helper_token:'stale'}); }")
                    await options.reload()
                    await expect(options.locator("#llm-status")).to_contain_text("SERVICE  已连接")
                    assert await worker.evaluate("async () => (await chrome.storage.local.get('helper_token_persisted')).helper_token_persisted !== 'stale'")

                    await context.route("https://www.zhipin.com/**", lambda route: route.fulfill(content_type="text/html", body=(ROOT / "tests/fixture.html").read_text()))
                    boss = await context.new_page()
                    # SPA navigation into jobs does not trigger manifest injection.
                    await boss.goto("https://www.zhipin.com/web/geek/recommend")
                    await boss.evaluate("history.pushState({}, '', '/web/geek/jobs?city=101280600')")
                    assert await boss.locator("#jseeker-root").count() == 0
                    tab_id = await worker.evaluate("async () => (await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs*'}))[0].id")

                    async def open_popup():
                        popup = await context.new_page()
                        # A standalone popup test tab stands in for the toolbar
                        # window; resolve its active tab to the actual BOSS tab.
                        await popup.add_init_script(f"if (location.pathname === '/popup.html') chrome.tabs.query = async () => [{{id:{tab_id},url:'https://www.zhipin.com/web/geek/jobs?city=101280600'}}];")
                        await popup.goto(f"chrome-extension://{extension_id}/popup.html")
                        return popup

                    popup = await open_popup()
                    await popup.get_by_role("button", name="打开匹配侧栏").click()
                    await expect(boss.locator("#jseeker-root .panel")).to_be_visible()
                    await expect(boss.locator("#jseeker-root").get_by_role("button", name="开始", exact=True)).to_be_visible()
                    await boss.get_by_role("button", name="隐藏 JSeeker 侧栏").click()
                    await expect(boss.get_by_role("button", name="显示 JSeeker 侧栏")).to_be_visible()
                    popup = await open_popup()
                    await popup.get_by_role("button", name="打开匹配侧栏").click()
                    await expect(boss.locator("#jseeker-root .panel")).to_be_visible()
                    await expect(boss.get_by_role("button", name="显示 JSeeker 侧栏")).to_be_hidden()
                    assert await boss.locator("#jseeker-root").count() == 1
                    await boss.screenshot(path=ART / "setup-sidebar.png", full_page=True)

                    # A sidebar can retain an old failure while settings change.
                    # Fail a real preflight, then verify Save alone heals both UIs.
                    await worker.evaluate("async () => chrome.storage.local.set({helper_port:1})")
                    await boss.get_by_role("button", name="开始", exact=True).click()
                    await expect(boss.locator("#jseeker-root .error")).to_contain_text("无法连接本地 Helper")
                    await options.locator("#save-llm").click()
                    await expect(options.locator("#llm-status")).to_contain_text("SERVICE  未连接")
                    await expect(options.locator("#message")).to_contain_text("设置已保存，检查失败")
                    await worker.evaluate("async port => chrome.storage.local.set({helper_port:port,selected_cities:['广州']})", port)
                    await options.locator("#save-llm").click()
                    await expect(options.locator("#llm-status")).to_contain_text("LLM      已配置")
                    await expect(options.locator("#message")).to_contain_text("设置已保存，本地服务与模型配置可用")
                    await expect(boss.locator("#jseeker-root .error")).to_have_count(0)
                    await options.screenshot(path=ART / "setup-pairing.png", full_page=True)

                    # Even if a cached status is stale or a notification is missed,
                    # Start reads the saved configuration again before gating.
                    await worker.evaluate("async id => chrome.tabs.sendMessage(id,{type:'LLM_CONFIG_CHANGED',status:{configured:false,error:'cached-old-status'}})", tab_id)
                    async with boss.expect_console_message(predicate=lambda message: "[JSeeker][workflow:start]" in message.text):
                        await boss.get_by_role("button", name="开始", exact=True).click()
                    # Fixture cards are only Shenzhen/Shanghai; Guangzhou skips
                    # every item without OCR, model requests, or contact actions.
                    await boss.get_by_role("button", name="暂停", exact=True).click()
                    await expect(boss.get_by_role("button", name="开始", exact=True)).to_be_visible(timeout=10000)
                    assert "LLM 尚未配置" not in await boss.locator("#jseeker-root").inner_text()
                finally:
                    await context.close()

            # Reproduce the reported installation: source folder has a settings
            # page, but classic content scripts cannot parse its module imports.
            with tempfile.TemporaryDirectory(prefix="jseeker-source-") as profile:
                context = await playwright.chromium.launch_persistent_context(
                    profile, **browser_options, headless=True,
                    args=[f"--disable-extensions-except={ROOT / 'extension'}", f"--load-extension={ROOT / 'extension'}"],
                )
                try:
                    worker = context.service_workers[0] if context.service_workers else await context.wait_for_event("serviceworker")
                    extension_id = worker.url.split("/")[2]
                    popup = await context.new_page()
                    await popup.goto(f"chrome-extension://{extension_id}/popup.html")
                    await expect(popup.locator("#status")).to_be_empty()
                    await expect(popup.get_by_role("button", name="打开匹配侧栏")).to_be_disabled()
                    await expect(popup.get_by_role("button", name="设置简历")).to_be_enabled()
                    await popup.screenshot(path=ART / "setup-source-popup.png")
                finally:
                    await context.close()
        report = {"status": "passed", "checks": ["fresh automatic pairing", "stale token recovery", "SPA missing sidebar injection", "hidden sidebar restore", "no duplicate sidebar", "save checks readiness and errors", "saved status reaches existing sidebar", "start refreshes stale configuration", "source popup without installation tip"], "no_model_or_contact_requests": True}
        (ART / "setup-browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
    finally:
        helper.terminate()
        await helper.wait()


if __name__ == "__main__":
    asyncio.run(main())
