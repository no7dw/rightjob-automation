"""BOSS bonus draft fixtures. No real recruiter or model service is used."""
import asyncio
import os
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts/liepin"
ART.mkdir(parents=True, exist_ok=True)

def boss_fixture_response(url, listing):
    mode = listing.get("chat_mode", "chat")
    name = "boss-chat-fixture.html" if "/web/geek/chat" in url else "boss-bonus-detail-fixture.html" if "/job_detail/" in url else None
    return (ROOT / "tests" / name).read_text().replace("__BONUS_MODE__", mode) if name else listing["value"]

async def verify_boss_bonus(ctx, worker, boss_page, boss_listing, boss_fixture, wait_state, modes=None):
    # Bonus drafts are optional and never require manual acknowledgement.
    # Every bonus starts in an isolated JD tab. Neither the site's initial
    # contact nor Continue Chat may navigate or mutate the original list.
    draft_text = "加分项也涉及，包括production AI agents等。"
    for scenario in modes or ["inline", "chat", "chat_same", "chat_spa", "chat_first_same", "chat_reload_detail", "chat_wrong", "chat_existing", "chat_ambiguous", "chat_missing", "chat_no_link", "chat_delayed", "chat_already", "chat_resume", "chat_no_matches", "chat_no_script", "inline_auto", "chat_auto", "chat_late_reset_auto", "chat_existing_auto", "chat_wrong_auto", "chat_unconfirmed_auto"]:
        auto_send = scenario.endswith("_auto")
        bonus_mode = scenario.removesuffix("_auto")
        print(f"BOSS bonus scenario: {scenario}", flush=True)
        # Wait for the previous workflow's finally block before resetting storage.
        if await boss_page.locator("#jseeker-root").count():
            await expect(boss_page.get_by_role("button", name="开始", exact=True)).to_be_enabled()
        await worker.evaluate("()=>chrome.storage.local.set({run:null,lease:null,job_index:{},contacted_jobs:{},evaluation_cache:{},run_target:2,allow_bonus_message:true,auto_send_bonus_message:false})")
        total_jobs = 3 if bonus_mode in ["chat_already", "chat_resume"] else 2
        boss_listing["value"] = boss_fixture.replace("n<=1", f"n<={total_jobs}").replace("-K", "30-50K·13薪")
        boss_listing["chat_mode"] = bonus_mode
        await boss_page.bring_to_front()
        await boss_page.reload()
        if bonus_mode == "chat_resume":
            # Establish and collect a real fixture contact without the bonus
            # feature, then enable it on the same durable batch and scores.
            await worker.evaluate("()=>chrome.storage.local.set({allow_bonus_message:false,run_target:1})")
            await boss_page.reload()
            await boss_page.evaluate("()=>fixture.bonusMode='chat'")
            await boss_page.get_by_role("button", name="开始", exact=True).click()
            await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed")
            await worker.evaluate("""async()=>{const {run}=await chrome.storage.local.get('run');
                run.status='paused';await chrome.storage.local.set({run,allow_bonus_message:true,run_target:2});}""")
            await boss_page.reload()
        auto_option = boss_page.get_by_role("checkbox", name="自动发送加分项消息", exact=True)
        await expect(auto_option).not_to_be_checked()
        if auto_send:
            await auto_option.check()
            await boss_page.reload()
            await expect(auto_option).to_be_checked()
        await boss_page.evaluate("mode=>fixture.bonusMode=mode", bonus_mode)
        list_url = boss_page.url
        list_document = await boss_page.evaluate("()=>{window.listDocument=crypto.randomUUID();return listDocument}")
        await expect(boss_page.get_by_role("checkbox", name="允许追加加分项消息", exact=True)).to_be_checked()
        await boss_page.evaluate("""()=>{
            const list=document.querySelector('.job-list-container');
            list.style.height='320px';list.firstElementChild.firstElementChild.style.marginTop='320px';list.scrollTop=200;
            document.querySelector('.condition-filter-select').textContent='深圳';
        }""")
        await worker.evaluate("""async()=>{
            globalThis.bonusParent=(await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs*'}))[0].id;
            globalThis.bonusHandoffs=[];globalThis.bonusBefore=null;
            globalThis.bonusOriginalUpdate ||= chrome.tabs.update.bind(chrome.tabs);
            const snapshot=async()=> (await chrome.scripting.executeScript({target:{tabId:bonusParent},func:()=>({
                scroll:document.querySelector('.job-list-container').scrollTop,
                scope:document.querySelector('.search-condition').textContent,
                city:document.querySelector('.condition-filter-select').textContent,
                url:location.href,document:window.listDocument,
            })}))[0].result;
            chrome.tabs.update=async(id,patch)=>{
                if(id!==bonusParent && patch.active && patch.url?.includes('/job_detail/'))bonusBefore=await snapshot();
                if(id===bonusParent && patch.active && bonusBefore){
                    bonusHandoffs.push({before:bonusBefore,after:await snapshot()});bonusBefore=null;
                }
                return bonusOriginalUpdate(id,patch);
            };
        }""")
        await boss_page.get_by_role("button", name="开始", exact=True).click()
        if bonus_mode in ['chat_scope_drift','chat_manual_pause']:
            pending=await wait_state(worker, lambda s: (s.get('run') or {}).get('bonus_review',{}).get('detail_tab') is not None)
            original_id=pending['run']['id']
            await boss_page.bring_to_front()
            if bonus_mode=='chat_scope_drift':
                await boss_page.evaluate("()=>{document.querySelector('.search-condition').textContent='推荐';history.replaceState({},'','/web/geek/jobs')}")
            else:
                await boss_page.get_by_role('button',name='暂停',exact=True).click()
            await expect(boss_page.get_by_role('button',name='开始',exact=True)).to_be_enabled(timeout=10000)
            ended=await wait_state(worker, lambda s:not (s.get('run') or {}).get('bonus_review'))
            assert ended['run']['id']==original_id and ended['run']['applications']['job1']['bonus_draft']['status']=='editor_interrupted'
            assert 'job1' not in ended.get('contacted_jobs',{}), 'an unopened JD must not be recorded as contacted'
            assert not await worker.evaluate("async()=>(await chrome.storage.local.get('archives')).archives?.length||0")
            if bonus_mode=='chat_scope_drift':
                await expect(boss_page.locator('#jseeker-root')).to_contain_text('BOSS 筛选范围已变化')
            for detail in [p for p in ctx.pages if '/job_detail/' in p.url]:
                assert await detail.evaluate("Number(sessionStorage.getItem('initialClicks')||0)")==0
                await detail.close()
            print(f'{bonus_mode}: retained batch, no greeting/send, no automatic restart',flush=True)
            continue
        if os.environ.get("JSEEKER_TEST_SLOW_SCORE") == "1":
            # Do not poll/evaluate the worker: those API calls mask idle expiry.
            await expect(boss_page.locator("#jseeker-root")).to_contain_text("COMPLETED", timeout=65000)
        if bonus_mode == "chat_no_matches":
            try:
                finished = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed", timeout=40)
            except AssertionError:
                print(await boss_page.locator("#jseeker-root").evaluate("host=>host.shadowRoot.querySelector('.panel')?.innerText"), flush=True)
                raise
            assert not finished["run"].get("bonus_review")
            assert finished["run"]["scores"]["job1"]["bonus_matches"] == []
            assert "加分项" in finished["run"]["jobs"][0]["jd_raw"]
            await boss_page.locator('.job-card-box .job-name').first.click()
            await expect(boss_page.locator("#jseeker-root")).to_contain_text("未追加消息：评分结果没有可由简历原文核实的加分项匹配")
            assert not [page for page in ctx.pages if "/web/geek/chat" in page.url]
            continue
        try:
            finished = await wait_state(worker, lambda s: (s.get("run") or {}).get("status") == "completed", timeout=40)
        except AssertionError:
            print("Sidebar:", await boss_page.locator("#jseeker-root").evaluate("host=>host.shadowRoot.querySelector('.panel')?.innerText"), flush=True)
            print("Applications:", await worker.evaluate("async()=>{const {run}=await chrome.storage.local.get('run');return run?.applications}"), flush=True)
            raise
        assert not finished["run"].get("bonus_review")
        assert len(finished["run"]["jobs"]) == total_jobs
        statuses = {"chat_wrong":"identity_unverified", "chat_existing":"existing_draft",

            "chat_no_script":"editor_timeout", "chat_unconfirmed":"send_unconfirmed"}
        draft_status = finished["run"]["applications"]["job1"]["bonus_draft"]["status"]
        if bonus_mode in statuses:
            assert draft_status == statuses[bonus_mode], draft_status
        else:
            assert draft_status in (["sent"] if auto_send else ["prepared", "already_prepared"]), draft_status
        assert boss_page.url == list_url
        assert await boss_page.evaluate("listDocument") == list_document
        handoffs=await worker.evaluate("bonusHandoffs")
        assert handoffs and all(item['before']==item['after'] for item in handoffs), handoffs
        assert any(item['before']['scroll']>0 for item in handoffs), handoffs
        assert await boss_page.evaluate("fixture.continueClicks") == 0
        expected_list_greetings = total_jobs - 1
        # job1 is handled in the isolated tab; the original list only greets job2.
        assert await boss_page.evaluate("fixture.chatClicks") == expected_list_greetings
        list_tab = await worker.evaluate("async()=> (await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs*'}))[0]")
        assert list_tab["active"], "the batch must return to the original list without manual clicks"
        if bonus_mode == "chat_no_script":
            for page in ctx.pages:
                if page.url == "about:blank" or '/job_detail/' in page.url: await page.close()
            continue
        assert await boss_page.locator('#chat-input').count() == 0
        chats = [page for page in ctx.pages if "/web/geek/chat" in page.url or '/job_detail/' in page.url]
        if draft_status == "sent":
            # A successful one-shot auto-send closes its owned chat tab.
            assert len(chats) == 0
            continue
        assert len(chats) == 1
        chat_page = chats[0]
        assert await chat_page.evaluate("Number(sessionStorage.getItem('initialClicks')||0)") == (0 if bonus_mode in ['chat_already','chat_resume'] else 1)
        assert await chat_page.evaluate("contactClicks") == [], "must use the JD-opened conversation without searching contacts"
        if bonus_mode != 'inline':
            assert "fixture_job=" in chat_page.url, "the site button must choose the conversation URL"
        if bonus_mode == "chat_existing":
            await expect(chat_page.locator("#chat-input")).to_have_text("我自己写的消息")
        elif bonus_mode == "chat_unconfirmed":
            await expect(chat_page.locator("#chat-input")).to_have_text(draft_text)
        elif bonus_mode in statuses:
            await expect(chat_page.locator("#chat-input")).to_be_empty()
        else:
            await expect(chat_page.locator("#chat-input")).to_have_text("" if auto_send else draft_text)
            if bonus_mode in ["chat", "chat_no_link"]:
                await chat_page.screenshot(path=str(ART / f"boss-direct-{bonus_mode}.png"), full_page=True)
            # The second job finishes while the first draft is still unsent.
            await chat_page.reload()
            await expect(chat_page.locator('#chat-input')).to_be_visible()
            await expect(chat_page.locator("#chat-input")).to_have_text("" if auto_send else draft_text)
        expected_sends = 1 if auto_send and bonus_mode in ["inline", "chat", "chat_late_reset", "chat_unconfirmed"] else 0
        assert await chat_page.evaluate("sendClicks") == expected_sends
        if bonus_mode == "chat_unconfirmed":
            await chat_page.reload()
            await expect(chat_page.locator('#chat-input')).to_be_visible()
            await expect(chat_page.locator("#chat-input")).to_have_text(draft_text)
            assert await chat_page.evaluate("sendClicks") == 1
        await chat_page.close()

    await worker.evaluate("()=>{if(globalThis.bonusOriginalUpdate)chrome.tabs.update=bonusOriginalUpdate}")
    import json
    (ART / 'boss-isolated-bonus-report.json').write_text(json.dumps({
        'status':'passed','scenarios':modes or ['full suite'],
        'checks':['original list document retained','preset, city and URL retained',
            'nonzero scroll offset retained across tab handoffs','no Continue Chat in original list',
            'owned detail and chat tabs only','single initial greeting','no real recruiter messages'],
    },ensure_ascii=False,indent=2)+'\n')

async def main():
    from liepin_flow_browser_test import Model
    class SlowModel(Model):
        delayed = False
        def do_POST(self):
            if not type(self).delayed:
                import time
                type(self).delayed = True
                time.sleep(35)
            super().do_POST()
    model = ThreadingHTTPServer(("127.0.0.1", 0), SlowModel if os.environ.get("JSEEKER_TEST_SLOW_SCORE") == "1" else Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    env = dict(os.environ, JSEEKER_PORT="17484", JSEEKER_TOKEN="boss-bonus-token",
        OPENAI_BASE_URL=f"http://127.0.0.1:{model.server_port}/v1",
        OPENAI_MODEL="fixture-fast", OPENAI_API_KEY="fixture-key",
        JSEEKER_JD_LOG_PATH=str(ART / "boss-bonus-jd.jsonl"))
    helper = await asyncio.create_subprocess_exec("node", "helper/server.mjs", cwd=ROOT,
        env=env, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    async def wait_state(worker, predicate, timeout=25):
        state = {}
        for _ in range(timeout * 10):
            state = await worker.evaluate("()=>chrome.storage.local.get(['run','liepin_task','contacted_jobs'])")
            if predicate(state): return state
            await asyncio.sleep(0.1)
        run = state.get("run") or {}
        raise AssertionError(f"timed out: status={run.get('status')} reason={run.get('stop_reason')} review={run.get('bonus_review')}")
    try:
        for _ in range(40):
            try:
                request = urllib.request.Request("http://127.0.0.1:17484/health", data=b"{}",
                    headers={"Authorization":"Bearer boss-bonus-token", "Content-Type":"application/json"})
                with urllib.request.urlopen(request, timeout=1): break
            except Exception: await asyncio.sleep(0.1)
        async with async_playwright() as p:
            with tempfile.TemporaryDirectory(prefix="jseeker-boss-bonus-") as profile:
                ctx = await p.chromium.launch_persistent_context(profile, channel="chromium", headless=True,
                    viewport={"width":1440,"height":1000}, args=[
                        f"--disable-extensions-except={ROOT / 'dist'}", f"--load-extension={ROOT / 'dist'}"])
                boss_fixture = (ROOT / "tests/fixture.html").read_text().replace("n<=35", "n<=1")
                boss_listing = {"value":boss_fixture}
                await ctx.route("https://www.zhipin.com/**", lambda route: route.fulfill(content_type="text/html",
                    body=boss_fixture_response(route.request.url, boss_listing)))
                worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event("serviceworker")
                options = await ctx.new_page()
                await options.goto(f"chrome-extension://{worker.url.split('/')[2]}/options.html")
                await options.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                await worker.evaluate("""async () => chrome.storage.local.set({helper_port:17484,
                    helper_token_persisted:'boss-bonus-token',run_target:2,match_threshold:80,
                    selected_cities:['深圳','上海'],llm_model:'fixture-fast',llm_base_url:'',
                    profile:{version:'fixture-cv',text:'I build production AI agents and lead engineering teams.'}})""")
                boss_page = await ctx.new_page()
                await boss_page.goto("https://www.zhipin.com/web/geek/jobs?city=101280600")
                modes = os.environ.get("JSEEKER_BONUS_MODES", "").split(",") if os.environ.get("JSEEKER_BONUS_MODES") else None
                try:
                    await verify_boss_bonus(ctx, worker, boss_page, boss_listing, boss_fixture, wait_state, modes)
                finally:
                    await ctx.close()
        print("BOSS bonus fixtures passed: automatic continuation with unsent drafts, wrong-chat refusal; no real messages")
    finally:
        helper.terminate()
        await helper.wait()
        model.shutdown()

if __name__ == "__main__":
    asyncio.run(main())
