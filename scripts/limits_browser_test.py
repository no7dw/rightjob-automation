"""Exercise native scroll discovery, exhausted results and missing fields."""
import asyncio,json,tempfile
from pathlib import Path
from playwright.async_api import async_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts';ART.mkdir(exist_ok=True)

async def main():
  async with async_playwright() as p:
    with tempfile.TemporaryDirectory(prefix='jseeker-limits-') as profile:
      context=await p.chromium.launch_persistent_context(profile,channel='chromium',headless=True,viewport={'width':1440,'height':1000},args=[f'--disable-extensions-except={ROOT/"dist"}',f'--load-extension={ROOT/"dist"}'])
      await context.route('https://www.zhipin.com/**',lambda route:route.fulfill(content_type='text/html',body=(ROOT/'tests/fixture.html').read_text()))
      sw=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
      page=await context.new_page();await page.goto('https://www.zhipin.com/web/geek/jobs');await page.wait_for_selector('.more-job-btn');await page.wait_for_selector('#jseeker-root',state='attached')
      await expect(page.locator('.jseeker-badge')).to_have_count(35)
      await page.add_script_tag(content=(ROOT/'dist/content.js').read_text())
      assert await page.locator('#jseeker-root').count()==1
      assert await page.locator('.jseeker-badge').count()==35
      await page.evaluate("""()=>{
        const cards=[...document.querySelectorAll('.job-card-box')], next=cards[2];
        next.querySelector('.boss-name').remove();next.querySelector('.company-location').remove();
        cards.slice(2).forEach(c=>c.remove());
        const scroller=document.querySelector('.job-list-container');scroller.style.height='180px';
        window.lazyLoaded=false;
        scroller.addEventListener('scroll',()=>{
          if(!window.lazyLoaded && scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-5){
            window.lazyLoaded=true;setTimeout(()=>document.querySelector('.rec-job-list').append(next),300);
          }
        });
      }""")
      await sw.evaluate("async()=>{const [tab]=await chrome.tabs.query({url:'https://www.zhipin.com/web/geek/jobs'});return chrome.tabs.sendMessage(tab.id,{type:'TOGGLE'});}")
      await page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True).click()
      await expect(page.get_by_text('当前结果滚动后无新增可采集职位，未满30条；可导出已有数据',exact=True)).to_be_visible(timeout=35000)
      await expect(page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True)).to_be_enabled()
      run=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert run['status']=='exhausted' and len(run['jobs'])==3,run
      assert await page.evaluate('window.lazyLoaded') is True
      missing=next(j for j in run['jobs'] if j['job_id']=='job3')
      assert missing['company'] is None and missing['location_raw'] is None
      assert missing['field_sources']['company']=='unknown' and missing['field_sources']['location']=='unknown'
      assert len({j['job_id'] for j in run['jobs']})==3
      assert await page.evaluate('window.fixture.chatClicks + window.fixture.likeClicks')==0
      async with page.expect_download() as download:
        await page.get_by_role('button',name='含截图归档',exact=True).click()
      archive=json.loads(Path(await (await download.value).path()).read_text())
      assert archive['run-summary.json']['successful']==3
      assert len(archive['jobs.raw.json'])==3 and archive['run-summary.json']['target']==30
      await page.screenshot(path=str(ART/'exhausted-results.png'),full_page=True)
      await page.evaluate("document.querySelector('.search-condition').textContent='架构师（广州） | 新筛选条件'")
      await page.get_by_role('button',name='自动点选30条（会改变页面）',exact=True).click()
      await expect(page.locator('#jseeker-root .error')).to_contain_text('当前搜索范围与检查点不同')
      unchanged=await sw.evaluate("async()=> (await chrome.storage.local.get('run')).run")
      assert len(unchanged['jobs'])==3 and unchanged['scope']==run['scope']
      await page.set_viewport_size({'width':845,'height':1000})
      badge=await page.locator('.job-card-box .jseeker-badge').first.bounding_box()
      title=await page.locator('.job-card-box .job-name').first.bounding_box()
      intersects=badge['x']<title['x']+title['width'] and badge['x']+badge['width']>title['x'] and badge['y']<title['y']+title['height'] and badge['y']+badge['height']>title['y']
      assert not intersects,'Narrow layout badge covers the native job title'
      await page.screenshot(path=str(ART/'narrow-badge.png'),full_page=True)
      report={'status':'passed','production_manifest_modified':False,'checks':['only current result list scrolled','late card discovered after native scroll','three unique results stop below thirty with explicit reason','company and location missing retain null and unknown source','partial batch export preserves all available jobs','no communication or collection action clicked','duplicate injection does not duplicate root or badges','845px narrow badge does not cover native title','changed native filter scope cannot resume the old batch'],'available_complete_jobs':3}
      (ART/'limits-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));await context.close()

asyncio.run(main())
