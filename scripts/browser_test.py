"""Run the real unpacked extension in an isolated Chromium profile with routed fixture pages."""
import asyncio,json,tempfile,os,base64,subprocess,secrets,urllib.request,time
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts';ART.mkdir(exist_ok=True)

async def main():
  errors=[]
  async with async_playwright() as p:
    with tempfile.TemporaryDirectory(prefix='jseeker-test-') as profile:
      context=await p.chromium.launch_persistent_context(profile,channel='chromium',headless=True,viewport={'width':1440,'height':1000},args=[f'--disable-extensions-except={ROOT / "dist"}',f'--load-extension={ROOT / "dist"}'])
      await context.route('https://www.zhipin.com/**',lambda route:route.fulfill(content_type='text/html',body=(ROOT/('tests/boss-saved-probe.html' if 'probe=real' in route.request.url else 'tests/fixture.html')).read_text()))
      sw=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
      ext=sw.url.split('/')[2]
      page=await context.new_page();page.on('console',lambda m: print('CONSOLE',m.text) if 'JSEEKER' in m.text else None);page.on('pageerror',lambda e:errors.append(str(e)))
      await page.goto('https://www.zhipin.com/web/geek/jobs')
      await page.wait_for_selector('#jseeker-root',state='attached')
      async def toggle(url='https://www.zhipin.com/web/geek/jobs'):
        await sw.evaluate("async url => { const tabs=await chrome.tabs.query({});const tab=tabs.find(t=>t.url===url);return chrome.tabs.sendMessage(tab.id,{type:'TOGGLE'}); }",url)
      await toggle()
      await expect(page.get_by_text('当前识别到 35 张卡片',exact=False)).to_be_visible()
      await page.wait_for_selector('.more-job-btn')
      await page.get_by_role('button',name='探查一条',exact=True).click()
      try:
        await expect(page.get_by_text('单职位探查完成',exact=True)).to_be_visible(timeout=15000)
      except Exception:
        print('DEBUG',await sw.evaluate("async()=>await chrome.storage.local.get(['run','lease'])"))
        print('PANEL',await page.locator('#jseeker-root').evaluate('(e)=>e.shadowRoot.innerHTML'))
        await page.screenshot(path=str(ART/'failure.png'));raise
      saved=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert len(saved['jobs'])==1
      assert saved['jobs'][0]['job_id']=='job1'
      assert saved['jobs'][0]['company']=='模拟公司 1'
      assert saved['jobs'][0]['location_raw']=='上海'
      assert '隐藏噪声' not in saved['jobs'][0]['jd_raw']
      assert 'securityId' not in saved['jobs'][0]['url']
      await page.get_by_role('button',name='规则评分',exact=True).click()
      await expect(page.get_by_text('按新权重重算',exact=True)).to_be_enabled(timeout=10000)
      saved=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert saved['scores']['job1']['engine']=='rules'
      assert saved['scores']['job1']['match_score'] is not None
      # Review real UI, export through actual content and background scripts.
      await page.get_by_text('匹配理由 / 校正 / 人工审核',exact=True).click()
      await page.get_by_label('审核 Agent平台架构师').select_option('possible')
      await page.get_by_placeholder('人工审核理由').fill('fixture: check responsibilities')
      await page.get_by_role('button',name='保存人工审核',exact=True).click()
      await expect(page.get_by_text('Precision@10',exact=False)).to_contain_text('100%')
      downloads=[];page.on('download',lambda d:downloads.append(d))
      await page.get_by_role('button',name='导出 JSON',exact=True).click()
      for _ in range(50):
        if len(downloads)>=1:break
        await asyncio.sleep(.1)
      assert len(downloads)==1
      archive_path=await downloads[0].path();archive=json.loads(Path(archive_path).read_text())
      assert archive['jobs.raw.json'][0]['job_id']=='job1'
      assert archive['review.json']['job1']['human_label']=='possible'
      await page.get_by_role('button',name='导出 CSV',exact=True).click()
      for _ in range(50):
        if len(downloads)>=2:break
        await asyncio.sleep(.1)
      assert len(downloads)==2
      assert 'job_id' in Path(await downloads[1].path()).read_text().splitlines()[0]
      await page.screenshot(path=str(ART/'extension-fixture.png'),full_page=True)
      # Resume then pause, reload and ensure persistent checkpoints survive.
      await page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True).click()
      try:
        await expect(page.get_by_text('完整 2/30',exact=False)).to_be_visible(timeout=15000)
      except Exception:
        print('RESUME STATE',await sw.evaluate("async()=>{const {run,lease}=await chrome.storage.local.get(['run','lease']);return {status:run?.status,reason:run?.stop_reason,attempts:run?.attempts,current:run?.current,lease};}"))
        print('PANELERROR',await page.locator('#jseeker-root').evaluate("e=>e.shadowRoot.querySelector('.body').innerText"));raise
      await page.get_by_role('button',name='暂停',exact=True).click()
      await expect(page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True)).to_be_enabled(timeout=15000)
      saved=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert len({j['job_id'] for j in saved['jobs']})==len(saved['jobs'])
      pu=next(j for j in saved['jobs'] if j['job_id']=='job2')
      assert 'salary_unknown' in pu['quality_flags']
      assert pu['salary_raw']=='-K'
      assert await page.evaluate('window.fixture.chatClicks + window.fixture.likeClicks')==0
      count=len(saved['jobs']);await page.reload();await page.wait_for_selector('#jseeker-root',state='attached');await toggle()
      persisted=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert len(persisted['jobs'])==count
      await page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True).click()
      await expect(page.get_by_text('完整 30/30',exact=False)).to_be_visible(timeout=120000)
      await expect(page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True)).to_be_enabled(timeout=15000)
      full=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert len(full['jobs'])==30 and full['status']=='completed'
      assert len({j['job_id'] for j in full['jobs']})==30
      assert await page.evaluate('window.fixture.chatClicks + window.fixture.likeClicks')==0
      (ART/'synthetic-30-run.json').write_text(json.dumps(full,ensure_ascii=False,indent=2))
      print('Synthetic 30-job ceiling verified',flush=True)
      # Check options page can reject invalid weights and keep CV redacted.
      options=await context.new_page();await options.goto(f'chrome-extension://{ext}/options.html')
      await expect(options.locator('#profile-meta')).to_contain_text('联系方式已移除')
      assert '@' not in await options.locator('#cv').input_value()
      await options.locator('#weight-skill').fill('0')
      await options.get_by_role('button',name='保存并重算',exact=True).click()
      await expect(options.locator('#message')).to_contain_text('总和为 100')
      await options.screenshot(path=str(ART/'extension-options.png'),full_page=True)
      # Replay a sanitized real DOM snapshot saved through a logged-in Brave profile.
      probe=await context.new_page();await probe.goto('https://www.zhipin.com/web/geek/jobs?probe=real')
      await probe.wait_for_selector('#jseeker-root',state='attached');await toggle(probe.url)
      await probe.get_by_role('button',name='新批次',exact=True).click()
      await probe.get_by_role('button',name='探查一条',exact=True).click()
      await expect(probe.get_by_text('单职位探查完成',exact=True)).to_be_visible(timeout=15000)
      real_run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      real=real_run['jobs'][0]
      assert real['job_id']=='4eae5637e5b10fb40nBy0ti5FFNR' and real['company']=='凯捷'
      assert '直聘' not in real['jd_raw'] and 'Multi-Agent' in real['jd_raw']
      assert real['location_verified'] is False
      (ROOT/'data/probes/jobs.raw.json').write_text(json.dumps({'evidence_origin':'Brave native saved-page DOM replay; only one real JD','jobs':[real]},ensure_ascii=False,indent=2))
      await probe.screenshot(path=str(ART/'real-dom-probe.png'),full_page=True)
      # Screenshot fixture -> real local Vision OCR. No cloud OCR or model requests.
      ocr_page=await context.new_page();await ocr_page.set_content('<div style="font:38px Arial;background:white;color:black;padding:20px">AI Agent Architect<br>30-50K · 13薪<br>公司：模拟科技</div>')
      png=await ocr_page.locator('div').screenshot(path=str(ART/'ocr-input.png'))
      result=subprocess.run([str(ROOT/'helper/vision-ocr')],input=png,capture_output=True,check=True)
      ocr=json.loads(result.stdout);assert '30' in ocr['text'] and '50' in ocr['text'] and 'Agent' in ocr['text']
      (ART/'ocr-result.json').write_text(json.dumps(ocr,ensure_ascii=False,indent=2))
      assert not errors,errors
      report={'status':'passed','isolated_profile':True,'actual_boss_automated':False,'checks':['actual MV3 injection','real BOSS selector structure','copy restriction','hidden DOM noise','async ID association','same-title different-ID','raw PUA preserved','location ignored','rules scoring','human review','separate JSON and CSV downloads','pause/resume','reload persistence','invalid weights rejected','redacted CV','Vision OCR salary and bilingual text','no chat or like clicks'],'synthetic_jobs':len(full['jobs']),'real_saved_page_jobs':len(real_run['jobs'])}
      (ART/'browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False))
      await context.close()

asyncio.run(main())
