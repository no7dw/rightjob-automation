"""Exercise the built extension on intercepted BOSS pages; no recruiter messages."""
import asyncio
import os
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
URL = "https://www.zhipin.com/web/geek/chat"


async def main():
    ART.mkdir(exist_ok=True)
    options = {"executable_path": os.environ["JSEEKER_TEST_BROWSER"]} if os.environ.get("JSEEKER_TEST_BROWSER") else {"channel": "chromium"}
    async with async_playwright() as p:
        with tempfile.TemporaryDirectory(prefix="jseeker-auto-reply-") as profile:
            ctx = await p.chromium.launch_persistent_context(profile, **options, headless=True,
                viewport={"width":1440,"height":1000}, args=[
                    f"--disable-extensions-except={ROOT / 'dist'}", f"--load-extension={ROOT / 'dist'}"])
            try:
                await ctx.route("https://www.zhipin.com/**", lambda route: route.fulfill(
                    content_type="text/html", body=(ROOT / ("tests/boss-auto-reply-live-markup-fixture.html" if "mode=live_" in route.request.url else "tests/boss-auto-reply-fixture.html")).read_text()))
                worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
                for _ in range(50):
                    if await worker.evaluate("() => !!globalThis.chrome?.storage?.local"):
                        break
                    await asyncio.sleep(0.1)
                else:
                    raise AssertionError("extension storage not ready")
                page = await ctx.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))

                async def reset(mode="normal", enabled=True):
                    await worker.evaluate("async enabled => chrome.storage.local.set({auto_reply_messages:enabled,boss_auto_reply_lease:null,boss_resume_attempts:{},run:null})", enabled)
                    await page.goto(f"{URL}?mode={mode}")
                    await page.bring_to_front()
                    await expect(page.get_by_role("checkbox", name="自动回复消息")).to_be_visible()

                async def events():
                    return await page.evaluate("events")

                async def popup():
                    tab_id = await worker.evaluate("async()=> (await chrome.tabs.query({url:'https://www.zhipin.com/*'}))[0].id")
                    view = await ctx.new_page()
                    await view.set_viewport_size({"width":248,"height":300})
                    await view.add_init_script(f"chrome.tabs.query=async()=>[{{id:{tab_id},url:'{URL}'}}];window.close=()=>{{window.popupClosed=true}};")
                    await view.goto(f"chrome-extension://{worker.url.split('/')[2]}/popup.html")
                    return view

                async def wait_popup_done(view):
                    # Extension CSP blocks wait_for_function's eval-based poller.
                    for _ in range(100):
                        if await view.evaluate("() => window.popupClosed === true"):
                            return
                        await asyncio.sleep(0.05)
                    raise AssertionError(await view.locator("#status").inner_text())

                # An already-open page may lack all chat content scripts after
                # extension reload. The toolbar button must recover it itself.
                await worker.evaluate("()=>chrome.storage.local.set({auto_reply_messages:false,boss_auto_reply_lease:null})")
                await page.goto("https://www.zhipin.com/")
                await page.evaluate("history.replaceState({},'', '/web/geek/chat')")
                assert await page.locator("#jseeker-auto-reply").count() == 0
                view = await popup()
                await expect(view.get_by_role("button", name="自动回复消息", exact=True)).to_be_enabled()
                await view.screenshot(path=ART / "boss-auto-reply-popup.png", full_page=True)
                await view.get_by_role("button", name="自动回复消息", exact=True).click()
                await wait_popup_done(view)
                await view.close()
                await page.bring_to_front()
                await expect(page.get_by_role("checkbox", name="自动回复消息")).to_be_checked()
                await page.wait_for_function("events.includes('read:decline')", timeout=6000)
                view = await popup()
                await view.get_by_role("button", name="停止自动回复", exact=True).click()
                await wait_popup_done(view)
                assert await worker.evaluate("async()=> (await chrome.storage.local.get('auto_reply_messages')).auto_reply_messages") is False
                await view.close()
                print("passed: toolbar starts without sidebar or chat script and stops processing", flush=True)

                await reset(enabled=False)
                await expect(page.get_by_role("checkbox", name="自动回复消息")).not_to_be_checked()
                await page.wait_for_timeout(1600)
                assert await events() == []
                await page.get_by_role("checkbox", name="自动回复消息").check()
                await page.wait_for_function("events.some(e=>e.startsWith('send:'))", timeout=15000)
                assert await events() == ["filter:unread", "read:decline", "read:cv", "open:resume", "pick:Candidate-CV-cn.pdf", "send:cv:Candidate-CV-cn.pdf"], await events()
                assert await page.evaluate("contacts.filter(c=>!c.read).map(c=>c.id)") == ["question", "apology"]
                await page.screenshot(path=ART / "boss-auto-reply.png", full_page=True)
                # Attempts survive reload even though the fixture restores unread asks.
                await page.reload()
                await page.wait_for_function("events.some(e=>e.startsWith('pick:'))", timeout=30000)
                await page.wait_for_timeout(1500)
                assert not any(e.startswith("send:") for e in await events())
                assert await page.evaluate("Number(sessionStorage.getItem('sends'))") == 1

                for mode in ["retry", "delayed", "wrong", "stale", "already", "missing", "ambiguous", "switch", "unconfirmed"]:
                    await reset(mode)
                    if mode in ["retry", "delayed", "unconfirmed"]:
                        await page.wait_for_function("events.some(e=>e.startsWith('send:'))", timeout=15000)
                        await page.wait_for_timeout(2600)
                        assert sum(e.startswith("send:") for e in await events()) == 1
                    else:
                        await page.wait_for_function("events.includes('read:cv')", timeout=10000)
                        await page.wait_for_timeout(5500 if mode == "wrong" else 2200)
                        assert not any(e.startswith("send:") for e in await events()), (mode, await events())
                    if mode in ["missing", "ambiguous"]:
                        assert not any(e.startswith("pick:") for e in await events()), (mode, await events())
                    print(f"passed: {mode}", flush=True)

                # Stop while a dialog is delayed: later UI must not trigger sending.
                await reset("normal")
                await page.evaluate("document.querySelector('.btn-resume').onclick=()=>{events.push('open:resume');setTimeout(()=>{document.querySelector('.dialog-wrap').hidden=false},1200)}")
                await page.wait_for_function("events.includes('open:resume')", timeout=10000)
                await worker.evaluate("()=>chrome.storage.local.set({auto_reply_messages:false})")
                await page.wait_for_timeout(2200)
                assert not any(e.startswith("send:") for e in await events())

                # Human contact switching pauses until the checkbox is toggled.
                await reset(enabled=False)
                await page.get_by_role("checkbox", name="自动回复消息").check()
                await page.wait_for_function("events.includes('filter:unread')", timeout=6000)
                await page.get_by_text("您能介绍一下项目经验吗", exact=True).click()
                await expect(page.locator("#jseeker-auto-reply")).to_contain_text("检测到手动操作")
                await page.wait_for_timeout(1500)
                assert not any(e.startswith("send:") for e in await events())

                view = await popup()
                await view.get_by_role("button", name="自动回复消息", exact=True).click()
                await wait_popup_done(view)
                await view.close()
                await page.bring_to_front()
                await page.wait_for_function("events.some(e=>e.startsWith('send:'))", timeout=15000)
                print("passed: toolbar resumes after manual pause", flush=True)

                # Use the actual name-box/name-text/last-msg-text structure,
                # selected inner row, name-only header and plain toolbar div
                # observed in JSeeker-BOSS, with synthetic content and no site JS.
                for mode in ["live_normal", "live_wrong", "live_conflict", "live_duplicate", "live_missing_identity"]:
                    await reset(mode)
                    if mode == "live_normal":
                        await page.wait_for_function("events.some(e=>e.startsWith('send:'))", timeout=15000)
                        assert await events() == ["filter:unread", "read:decline", "read:cv", "open:resume", "pick:Candidate-CV-cn.pdf", "send:cv:Candidate-CV-cn.pdf"], await events()
                        await expect(page.locator("#jseeker-auto-reply [role='status']")).to_contain_text("第 ")
                        await page.screenshot(path=ART / "boss-auto-reply-live-markup.png", full_page=True)
                    elif mode in ["live_duplicate", "live_missing_identity"]:
                        await expect(page.locator("#jseeker-auto-reply")).to_contain_text("无法确认唯一联系人", timeout=10000)
                        assert "read:cv" not in await events()
                    else:
                        await page.wait_for_function("events.includes('read:cv')", timeout=10000)
                        await page.wait_for_timeout(5000)
                    if mode != "live_normal":
                        assert not any(e.startswith("send:") for e in await events()), (mode, await events())
                    print(f"passed: {mode}", flush=True)

                # In-page navigation acquires the chat UI and restores the list UI.
                await worker.evaluate("()=>chrome.storage.local.set({auto_reply_messages:false})")
                await page.goto("https://www.zhipin.com/web/geek/recommend")
                await page.evaluate("""() => {
                    const list=document.createElement('div');list.id='jseeker-root';document.body.append(list);
                    history.pushState({},'', '/web/geek/chat');
                }""")
                await expect(page.get_by_role("checkbox", name="自动回复消息")).to_be_visible()
                await expect(page.locator("#jseeker-root")).to_be_hidden()
                await page.evaluate("history.pushState({},'', '/web/geek/recommend')")
                await expect(page.locator("#jseeker-auto-reply")).to_have_count(0)
                assert await page.locator("#jseeker-root").evaluate("node=>node.style.display") == ""

                # Hidden pages do not even mark a contact read.
                await reset(enabled=False)
                foreground = await ctx.new_page()
                await foreground.goto("about:blank")
                await foreground.bring_to_front()
                await worker.evaluate("()=>chrome.storage.local.set({auto_reply_messages:true})")
                await page.wait_for_timeout(1500)
                if await page.evaluate("document.hidden"):
                    assert await events() == []
                await foreground.close()

                # Background source checks reject unrelated contexts and malformed values.
                control = await ctx.new_page()
                await control.goto(f"chrome-extension://{worker.url.split('/')[2]}/popup.html")
                response = await control.evaluate("()=>chrome.runtime.sendMessage({type:'BOSS_AUTO_REPLY_AUTHORIZE_SEND',key:'a'.repeat(64),token:'forged'})")
                assert response["ok"] is False and "聊天页" in response["error"], response
                assert not errors, errors
                print("BOSS auto reply browser checks passed; only intercepted synthetic conversations were used")
            except Exception:
                if 'page' in locals() and not page.is_closed():
                    print("events:", await page.evaluate("globalThis.events"), flush=True)
                    print("sidebar:", await page.locator("#jseeker-auto-reply").evaluate("node=>node.shadowRoot.querySelector('.body')?.innerText") if await page.locator("#jseeker-auto-reply").count() else "missing", flush=True)
                    await page.screenshot(path=ART / "boss-auto-reply-failure.png", full_page=True)
                raise
            finally:
                await ctx.close()


if __name__ == "__main__":
    asyncio.run(main())
