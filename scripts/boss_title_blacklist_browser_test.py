"""Verify title rejection before navigation and recapture after rule changes."""
import asyncio
import json
import os
import socket
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright, expect
from blacklist_browser_test import ModelHandler

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'artifacts'

async def main():
    ModelHandler.calls = 0
    model = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    helper = await asyncio.create_subprocess_exec('node', 'helper/server.mjs', cwd=ROOT,
        env={**os.environ, 'JSEEKER_PORT':str(port), 'JSEEKER_TOKEN':'title-skip-test',
             'OPENAI_BASE_URL':f'http://127.0.0.1:{model.server_port}/v1',
             'OPENAI_MODEL':'blacklist-fixture', 'OPENAI_API_KEY':'fixture-key',
             'JSEEKER_JD_LOG_PATH':str(ART / 'title-skip-jd.jsonl')},
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                req = urllib.request.Request(f'http://127.0.0.1:{port}/health', data=b'{}',
                    headers={'Authorization':'Bearer title-skip-test','Content-Type':'application/json'})
                with urllib.request.urlopen(req, timeout=1): break
            except Exception: await asyncio.sleep(.1)
        async with async_playwright() as p:
            with tempfile.TemporaryDirectory(prefix='jseeker-title-skip-') as profile:
                ctx = await p.chromium.launch_persistent_context(profile, channel='chromium', headless=True,
                    viewport={'width':1440,'height':1000}, args=[
                    f'--disable-extensions-except={ROOT / "dist"}',f'--load-extension={ROOT / "dist"}'])
                try:
                    worker = ctx.service_workers[0] if ctx.service_workers else await ctx.wait_for_event('serviceworker')
                    setup = await ctx.new_page()
                    await setup.goto(f'chrome-extension://{worker.url.split("/")[2]}/options.html')
                    await setup.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                    await worker.evaluate('''async port=>chrome.storage.local.set({helper_port:port,
                        helper_token_persisted:'title-skip-test',run_target:1,match_threshold:100,
                        selected_cities:['深圳','上海'],llm_model:'blacklist-fixture',
                        allow_bonus_message:false,auto_send_bonus_message:false,
                        prefs:{salary_min_k:null,excluded_terms:['工程师']}})''', port)
                    fixture = (ROOT / 'tests/fixture.html').read_text().replace('n<=35','n<=3')
                    fixture = fixture.replace("show('job1');document", "list.firstElementChild.querySelector('.job-name').textContent='AI工程师';show('job1');document")
                    fixture = fixture.replace("detail.querySelector('#chat').onclick", "if(id==='job1')detail.querySelector('.job-name').textContent='AI工程师';if(id==='job2')detail.querySelector('.desc').textContent+=' 带领工程师团队 ';detail.querySelector('#chat').onclick")
                    await ctx.route('https://www.zhipin.com/**', lambda route:route.fulfill(content_type='text/html',body=fixture))
                    page = await ctx.new_page()
                    await page.goto('https://www.zhipin.com/web/geek/jobs?city=101280600')
                    await expect(page.get_by_role('button',name='开始',exact=True)).to_be_enabled()
                    # Ignore the fixture's initial detail display; measure scanner navigation only.
                    await page.evaluate('()=>fixture.showCalls=[]')
                    await page.get_by_role('button',name='开始',exact=True).click()
                    async def wait_run(predicate):
                        for _ in range(400):
                            run = await worker.evaluate("async()=>(await chrome.storage.local.get('run')).run")
                            if run and predicate(run): return run
                            await asyncio.sleep(.1)
                        raise AssertionError(str(run))
                    run = await wait_run(lambda r:'job3' in r.get('scores',{}) and r['status']=='exhausted')
                    calls = await page.evaluate('fixture.showCalls')
                    assert 'job1' not in calls, calls
                    assert 'job2' in calls and 'job3' in calls, calls
                    jobs = {j['job_id']:j for j in run['jobs']}
                    assert jobs['job1']['capture_scope']=='card' and jobs['job1']['jd_raw'] is None
                    assert jobs['job2']['blacklist_keyword']=='工程师' and jobs['job2']['jd_raw']
                    assert set(run['scores'])=={'job3'} and ModelHandler.calls==1
                    assert await page.evaluate('fixture.chatClicks')==0
                    await page.screenshot(path=str(ART / 'boss-title-skip.png'),full_page=True)
                    options = await ctx.new_page()
                    await options.goto(f'chrome-extension://{worker.url.split("/")[2]}/options.html')
                    result = await options.evaluate("async()=>chrome.runtime.sendMessage({type:'SET_BLACKLIST',keywords:''})")
                    assert result['ok'], result
                    await page.bring_to_front()
                    await page.get_by_role('button',name='开始',exact=True).click()
                    run = await wait_run(lambda r:len(r.get('scores',{}))==3 and r['status']=='exhausted')
                    assert 'job1' in await page.evaluate('fixture.showCalls')
                    assert len(run['jobs'])==len(run['seen'])==len(set(run['seen']))==3
                    assert all(j.get('capture_scope')!='card' and j['jd_raw'] for j in run['jobs'])
                    assert ModelHandler.calls==3, ModelHandler.calls
                    report={'status':'passed','scanner_opened_before_clear':calls,
                        'checks':['title rejected before detail navigation','JD-only match still inspected',
                        'skips avoided OCR and model','title skip recaptured after clearing blacklist',
                        'checkpoint IDs remained unique','no recruiter messages'], 'model_calls':ModelHandler.calls}
                    (ART / 'boss-title-skip-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
                    print(json.dumps(report,ensure_ascii=False))
                finally: await ctx.close()
    finally:
        helper.terminate()
        await helper.wait()
        model.shutdown()

if __name__=='__main__': asyncio.run(main())
