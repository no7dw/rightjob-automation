"""Rebuild reviewed JD evidence from local logs; no external services required."""
import collections, datetime, hashlib, json, pathlib, re
ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/logs/jd-items.jsonl'
OUT = ROOT / 'reports/jd-analysis/src/data.json'
raw_bytes = SOURCE.read_bytes()
lines = raw_bytes.decode('utf-8').split('\n')
rows = []
for i, line in enumerate(lines):
    if not line.strip(): continue
    try: rows.append(json.loads(line))
    except json.JSONDecodeError:
        if i == len(lines)-1 and not raw_bytes.endswith(b'\n'): continue
        raise
# Site scopes IDs; legacy IDs without a site are reconciled to an explicit site when observed.
known = {r['job']['job_id']: r.get('site') or r['job'].get('site') for r in rows if r.get('site') or r['job'].get('site')}
unique = {}
for r in sorted(rows, key=lambda r:r['timestamp']):
    j = r['job']; site = r.get('site') or j.get('site') or known.get(j['job_id']) or '未记录'
    unique[(site,j['job_id'])] = r
cities = '深圳 北京 上海 广州 杭州 成都 南京 苏州 武汉 西安 长沙 重庆 天津 合肥 郑州 厦门 珠海 东莞 佛山 惠州 无锡 宁波 青岛 济南 福州 柳州 香港'.split()
keywords = {
'AI / 人工智能':r'(?<![a-z])ai(?![a-z])|人工智能', 'LLM / 大模型':r'\bllms?\b|大模型|大语言模型',
'Agent / 智能体':r'agents?\b|智能体','Python':r'\bpython\b','RAG':r'\brag\b|检索增强','Java':r'\bjava\b',
'Go':r'\bgolang\b|\bgo\b','C++':r'c\+\+','Rust':r'\brust\b','SQL':r'\bsql\b',
'JavaScript':r'\bjavascript\b','TypeScript':r'\btypescript\b','React':r'\breact\b','Vue':r'\bvue(?:\.js)?\b',
'LangChain':r'\blangchain\b','LangGraph':r'\blanggraph\b','MCP':r'\bmcp\b','Prompt':r'\bprompt\b|提示词',
'多模态':r'多模态|multimodal','微调':r'微调|fine.tun|\blora\b','PyTorch':r'\bpytorch\b','TensorFlow':r'\btensorflow\b',
'机器学习':r'机器学习|machine learning','深度学习':r'深度学习|deep learning','推荐系统':r'推荐系统|推荐算法',
'计算机视觉':r'计算机视觉|computer vision','NLP':r'\bnlp\b|自然语言','Docker':r'\bdocker\b',
'Kubernetes':r'\bkubernetes\b|\bk8s\b','云计算':r'云计算|云原生|公有云|私有云|\baws\b|\bazure\b|阿里云|腾讯云',
'GPU':r'\bgpus?\b|\bcuda\b','vLLM':r'\bvllm\b','Redis':r'\bredis\b','MySQL':r'\bmysql\b',
'PostgreSQL':r'\bpostgres(?:ql)?\b','Kafka':r'\bkafka\b','Spark / Flink':r'\bspark\b|\bflink\b',
'分布式':r'分布式','微服务':r'微服务|microservices?','高并发':r'高并发','架构设计':r'架构设计|系统设计',
'团队管理':r'团队管理|团队建设|团队搭建','机器人':r'机器人|robotics?','嵌入式':r'嵌入式|embedded',
'Linux':r'\blinux\b','Spring':r'\bspring\b','全栈':r'全栈|full.stack','英语':r'英语|英文|english',
'开源':r'开源|open.source','数据分析':r'数据分析','测试':r'测试|testing', '产品':r'产品', '算法':r'算法'
}
themes = {
'AI 与智能应用':r'人工智能|大模型|智能体|\bai\b|\bllm\b',
'机器人与智能硬件':r'机器人|具身智能|智能硬件|嵌入式|传感器|无人机',
'金融与保险':r'金融|保险|银行|证券|投顾|量化交易|支付|风控',
'电商与零售':r'电商|电子商务|零售|跨境|独立站|商城',
'游戏与互动娱乐':r'游戏|手游|网游|博彩',
'医疗与健康':r'医疗|医药|医院|健康|康复|生物医学',
'教育与培训':r'教育|教学|校园|培训行业|在线课程',
'制造与工业':r'制造|工业|工厂|产线|质检|供应链',
'汽车与出行':r'汽车|自动驾驶|车联网|智能驾驶|出行',
'能源与电力':r'能源|电力|电网|光伏|储能',
'企业软件与云服务':r'\bsaas\b|企业软件|企业服务|云计算|云服务|云原生',
'内容与传媒':r'传媒|媒体|内容创作|视频生成|短视频|广告|直播'
}
records=[]; salary_rows=[]; city_rows=[]; scount=collections.Counter(); ccount=collections.Counter(); tcount=collections.Counter(); kcount=collections.Counter()
range_re=re.compile(r'(\d+(?:\.\d+)?)\s*[-~～—–至]\s*(\d+(?:\.\d+)?)\s*([kK千万])')
for (site,jid),r in unique.items():
    j=r['job']; jd=j.get('jd',''); text=j['title']+'\n'+jd
    tags=[k for k,p in keywords.items() if re.search(p,text,re.I)]
    topics=[k for k,p in themes.items() if re.search(p,text,re.I)]
    kcount.update(tags);tcount.update(topics);scount[site]+=1
    # Require explicit location markers; mentions elsewhere may describe clients or travel.
    found=set(); evidence=[]
    for m in re.finditer(r'工作地点(?:与方式)?|办公地点|工作城市|工作地址|办公地址|常驻|(?i:\bbase)\s*[:：]?|(?m:^地点\s*[:：])',jd):
        snippet=jd[m.start():m.end()+100].split('\n\n')[0]
        matched=[c for c in cities if c in snippet]
        if matched: found.update(matched);evidence.append(snippet)
    ccount.update(found)
    if found: city_rows.append({'title':j['title'],'cities':' / '.join(sorted(found)),'evidence':' | '.join(evidence),'site':site,'job_id':jid})
    for m in range_re.finditer(jd):
        snippet=jd[max(0,m.start()-25):m.end()+35]
        lo,hi=float(m[1]),float(m[2]); unit=m[3].lower()
        period='月薪（K 表述）' if unit=='k' else ('年薪（明确）' if '年薪' in snippet or '/年' in snippet else '周期不明确')
        # Do not annualize ambiguous budgets or merge several roles in one JD.
        salary_rows.append({'title':j['title'],'range':m.group(),'period':period,'evidence':snippet,'site':site,'job_id':jid,'lower':lo,'upper':hi,'unit':unit})
    records.append({'title':j['title'],'site':site,'job_id':jid,'keywords':tags,'topics':topics,'cities':sorted(found)})
N=len(records)
def counts(c): return [{'name':k,'count':v,'share':v/N} for k,v in c.most_common()]
for s in salary_rows:
    s['quality'] = '单位异常，排除统计' if s['unit']=='k' and s['upper']>1000 else '保留原文'
monthly=list({(s['job_id'],s['lower'],s['upper']):s for s in salary_rows if s['unit']=='k' and s['upper']<=1000}.values())
bins=[('＜20K',0,20),('20–30K',20,30),('30–40K',30,40),('40–50K',40,50),('≥50K',50,float('inf'))]
salary_bins=[{'name':label,'count':sum(a<=((s['lower']+s['upper'])/2)<b for s in monthly)} for label,a,b in bins]
hunter=[]
for (site,jid),r in unique.items():
    j=r['job']; text=j['jd']
    hits=[text[max(0,m.start()-25):m.end()+75] for m in re.finditer(r'猎头|headhunt',text,re.I)]
    explicit=bool(re.search(r'猎头岗位|本岗位由猎头|客户核心猎头',text))
    hunter.append({'title':j['title'],'site':site,'job_id':jid,'publisher':'明确猎头参与 / 代招' if explicit else '发布者身份未知','mention':bool(hits),'evidence':' | '.join(hits),'recruitingRole':bool(re.search(r'猎头|招聘|招聘顾问|headhunt|recruit',j['title'],re.I))})
hunter_counts=collections.Counter(r['publisher'] for r in hunter)
old=json.loads(OUT.read_text())
def query(data,note):return {'rows':data,'source':{'type':'file','name':'JD capture log','tables':['data/logs/jd-items.jsonl'],'description':note,'query':note,'retrievedAt':max(r['timestamp'] for r in rows)}}
old.update(title='JD 市场观察 · Job landscape',buildStatus='complete',generatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),report={'asOf':max(r['timestamp'] for r in rows)[:10]},filters=[],queries={
'hunter_counts':query(counts(hunter_counts),'Only explicit JD wording establishes hunter involvement. No publisher profile, recruiter identity, certification, or employer relationship is logged. Unknown is not direct hiring.'),
'hunter_evidence':query([r for r in hunter if r['mention'] or r['recruitingRole']], 'All hunter mentions and recruiting-title matches; role titles do not establish the publisher type.'),
'jobs':query(records,'Latest timestamp per (site, job_id); unspecified legacy site reconciled only when the same ID has an explicit site. No deduplication across different job IDs.'),
'keywords':query(counts(kcount),'Curated bilingual regex dictionary on title + JD. Document frequency: each keyword counts at most once per job. Labels can overlap.'),
'themes':query(counts(tcount),'Non-exclusive regex themes in title + JD; these are business/topic mentions, not verified employer industry labels.'),
'cities':query(counts(ccount),'City names within 100 characters of explicit work/base/location markers, stopping at paragraph boundary. Multi-city jobs count in each mentioned city; not a complete city distribution.'),
'city_evidence':query(city_rows,'Explicit location marker + nearby snippet; manual review recommended for client locations and multiple workplaces.'),
'salary_evidence':query(salary_rows,'All numeric ranges with K/千/万 units in JD. Ambiguous periods retained; not all are comparable job salary offers. No invented annual conversion.'),
'salary_bins':query(salary_bins,'Midpoint bins of K-denominated salary mentions only, interpreted as monthly convention; Repeated identical ranges in one job are collapsed; K ranges above 1000 are excluded as unit anomalies. Each range is an observation, not necessarily a unique job. No annualization or extra-month bonus assumption.'),
'sites':query(counts(scount),'Explicit logged site only; legacy records without site remain unknown unless reconciled by ID.')},
analysis={'raw':len(rows),'unique':N,'duplicates':len(rows)-N,'start':min(r['timestamp'] for r in rows),'end':max(r['timestamp'] for r in rows),'salaryJobs':len({s['job_id'] for s in salary_rows}),'monthlyRanges':len(monthly),'cityJobs':len(city_rows),'themeJobs':sum(bool(r['topics']) for r in records),'hunterExplicit':sum(r['publisher']=='明确猎头参与 / 代招' for r in hunter),'hunterMentions':sum(r['mention'] for r in hunter),'recruitingRoles':sum(r['recruitingRole'] for r in hunter),'sha256':hashlib.sha256(raw_bytes).hexdigest(),'dictionary':keywords,'themeRules':themes})
OUT.write_text(json.dumps(old,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(old['analysis']|{'dictionary':'saved','themeRules':'saved'},ensure_ascii=False,indent=2));print('keywords',kcount.most_common(10));print('cities',ccount);print('salary ranges',len(salary_rows))
