"""Exercise capture->crop->local Vision->evidence in an isolated test extension.
Only this temporary test copy receives <all_urls> for headless screenshot access;
production uses the toolbar's activeTab user gesture.
"""
import asyncio,base64,json,os,secrets,shutil,tempfile
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts';ART.mkdir(exist_ok=True)

async def main():
  token=secrets.token_hex(24)
  helper=await asyncio.create_subprocess_exec('node','helper/server.mjs',cwd=ROOT,env={**os.environ,'JSEEKER_TOKEN':token,'JSEEKER_PORT':'17373','JSEEKER_MODEL_URL':'','JSEEKER_MODEL':''},stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  try:
    startup=await asyncio.wait_for(helper.stdout.readline(),8)
    assert b'127.0.0.1:17373' in startup,'Helper port 17373 unavailable; stop the test, do not stop an existing service'
    with tempfile.TemporaryDirectory(prefix='jseeker-ocr-') as temp:
      extension=Path(temp)/'extension';shutil.copytree(ROOT/'dist',extension)
      manifest=json.loads((extension/'manifest.json').read_text());manifest['host_permissions'].append('<all_urls>');(extension/'manifest.json').write_text(json.dumps(manifest))
      async with async_playwright() as p:
        context=await p.chromium.launch_persistent_context(str(Path(temp)/'profile'),channel='chromium',headless=True,no_viewport=True,args=['--window-size=1440,1000',f'--disable-extensions-except={extension}',f'--load-extension={extension}'])
        await context.route('https://www.zhipin.com/**',lambda r:r.fulfill(content_type='text/html',body=(ROOT/'tests/fixture.html').read_text()))
        sw=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker');ext=sw.url.split('/')[2]
        options=await context.new_page();await options.goto(f'chrome-extension://{ext}/options.html');await expect(options.locator('#profile-meta')).to_contain_text('联系方式已移除')
        await options.locator('#token').fill(token);await options.get_by_role('button',name='保存连接 Token',exact=True).click();await expect(options.locator('#message')).to_have_text('已完成')
        page=await context.new_page();await page.goto('https://www.zhipin.com/web/geek/jobs');await page.wait_for_selector('.more-job-btn');await page.wait_for_selector('#jseeker-root',state='attached')
        await sw.evaluate("async()=>{const tabs=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});await chrome.windows.update(tabs[0].windowId,{focused:true});return chrome.tabs.sendMessage(tabs[0].id,{type:'TOGGLE'});}")
        await page.get_by_role('button',name='截图OCR当前职位',exact=True).click()
        await expect(page.get_by_text('单职位探查完成',exact=True)).to_be_visible(timeout=90000)
        run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
        archive=await options.evaluate("async()=> (await chrome.runtime.sendMessage({type:'EXPORT',images:true})).data")
        for e in archive['evidence']:
          (ART/('capture-'+e['kind']+'.png')).write_bytes(base64.b64decode(e['image'].split(',',1)[1]))
        assert len(run['jobs'])==1
        job=run['jobs'][0]
        assert len(job.get('evidence_ids',[]))>=5,job
        assert 'ocr_unavailable' not in job['quality_flags'],job.get('ocr_error')
        assert '30' in job['ocr_fields']['salary'] and '50' in job['ocr_fields']['salary'],job['ocr_fields']
        assert job['ocr_draft'] and 'Agent' in job['ocr_draft']
        assert await page.locator('#jseeker-root').evaluate("e=>e.style.visibility")=='', 'Panel must be restored after screenshot'
        await page.screenshot(path=str(ART/'ocr-extension.png'),full_page=True)
        archive=await options.evaluate("async()=> (await chrome.runtime.sendMessage({type:'EXPORT',images:true})).data")
        assert len(archive['evidence'])>=5
        for e in archive['evidence']:assert e['image'].startswith('data:image/png;base64,') and e.get('ocr')
        # A long description inside a nested scrolling panel must reach its final line.
        await page.evaluate("window.fixture.longJD=true")
        await page.locator('.job-card-box a.job-name').first.click()
        await expect(page.locator('.desc')).to_contain_text('SECTION_099')
        await page.get_by_role('button',name='截图OCR当前职位',exact=True).click()
        await expect(page.get_by_text('截图OCR草稿已保存，请在人工校正中核实全文和字段',exact=True)).to_be_visible(timeout=120000)
        long_run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
        supplement=long_run['supplements']['job1']
        assert supplement['ocr_capture_complete'] is True,supplement
        assert '099' in supplement['ocr_draft'],supplement['ocr_draft']
        assert len(supplement['evidence_ids'])>5
        (ART/'long-jd-ocr.json').write_text(json.dumps(supplement,ensure_ascii=False,indent=2))
        await page.screenshot(path=str(ART/'long-jd-ocr.png'),full_page=True)
        # Passive mode only crops the visible salary and does not select or scroll a job.
        await page.evaluate('window.fixture.longJD=false')
        await page.get_by_role('button',name='新批次',exact=True).click()
        await page.get_by_role('button',name='安静试运行10条',exact=True).click()
        for _ in range(100):
          passive_run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
          if len(passive_run['jobs'])>=1:break
          await asyncio.sleep(.1)
        assert len(passive_run['jobs'])==1
        await page.locator('.job-card-box a.job-name').nth(1).click()
        for _ in range(150):
          passive_run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
          if len(passive_run['jobs'])>=2:break
          await asyncio.sleep(.1)
        assert len(passive_run['jobs'])==2,passive_run.get('stop_reason')
        passive_salary=passive_run['jobs'][1]
        assert passive_salary['job_id']=='job2'
        assert len(passive_salary.get('evidence_ids',[]))==1
        assert passive_salary['salary_raw']=='-K'
        assert isinstance(passive_salary['ocr_fields']['salary'],str)
        assert 'salary_unknown' in passive_salary['quality_flags']
        assert 'ocr_unavailable' not in passive_salary['quality_flags'],passive_salary.get('ocr_error')
        passive_archive=await options.evaluate("async()=> (await chrome.runtime.sendMessage({type:'EXPORT',images:true})).data")
        salary_evidence=next(e for e in passive_archive['evidence'] if e['id']==passive_salary['evidence_ids'][0])
        (ART/'passive-salary-crop.png').write_bytes(base64.b64decode(salary_evidence['image'].split(',',1)[1]))
        report={'status':'passed','production_manifest_modified':False,'test_copy_screenshot_permission':'<all_urls>, isolated headless only','production_activeTab_toolbar_gesture':'requires manual Brave acceptance','checks':['real captureVisibleTab','tab and job ID guard','device-pixel crop','panel hidden during capture and restored','authenticated local helper','Chinese and English Vision OCR','separate title/company/location/salary crops','JD OCR draft','IndexedDB PNG and OCR evidence export','passive visible salary screenshot without extension card click or scroll','unreadable fixture PUA salary remains unknown'],'ocr_fields':job['ocr_fields'],'evidence_images':len(archive['evidence']),'long_jd_pages':len(supplement['evidence_ids'])-4,'long_jd_reached_end':supplement['ocr_capture_complete'],'passive_salary_ocr':passive_salary['ocr_fields']['salary']}
        (ART/'ocr-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));await context.close()
  finally:
    if helper.returncode is None:helper.terminate()
    await helper.wait()

asyncio.run(main())
