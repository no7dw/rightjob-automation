# JSeeker · Job Match

[English](README.md) | **简体中文**

Chrome / Brave Manifest V3 扩展：在 BOSS 直聘与猎聘的原生城市与筛选结果中逐个采集 JD，使用本地截图 OCR 补齐乱码字段，再调用 LLM 对照 CV 给出 0–100 匹配分。达到阈值的职位自动进入沟通/申请阶段。

架构说明与新增职位网站的分步指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 支持的网站

| 网站 | 域名 | 状态 |
| --- | --- | --- |
| BOSS 直聘 | `zhipin.com` | 已支持 |
| 猎聘 | `liepin.com`、`c.liepin.com` | 已支持 |
| Glassdoor | `glassdoor.com` | 计划中，见 [路线图](#路线图) |
| Indeed | `indeed.com` | 计划中，见 [路线图](#路线图) |

## 主流程

1. 在 BOSS 页面使用原生城市、Title 和职位筛选。
2. 扩展右侧面板默认打开，提供 Score 阈值、主要城市多选、运行数量、开始/暂停、重试失败、新批次和 CSV 导出。
3. 点击“开始”后，串行采集列表中尚未处理的 JD。
4. 本地 OCR 默认启用，不需要在主界面设置。
5. LLM 输出匹配分，分数直接显示在左侧职位卡片。
6. 达到阈值的职位自动打开“立即沟通”入口，不逐条确认；加分项消息仅在单独开启“自动发送”后提交。
7. 已评分和已沟通职位按 `job_id` 持久化复用，不会重复采集或重复申请。
8. 卡片地点未命中城市多选时直接跳过，不打开 JD、不调用 OCR/LLM，也不进入沟通。
9. 设置页「JD 黑名单」可输入多个逗号分隔的关键词（例如 `外包,驻场,销售`），「公司黑名单」可输入公司名关键词；两个已保存列表都以单行标签展示，可用 `×` 移除并自动保存。标题、JD 或 OCR 补充文本命中 JD 黑名单，或公司名命中公司黑名单时跳过，英文不区分大小写；跳过项不评分、不进入沟通、不占运行数量，并在卡片和侧栏中标记。BOSS 列表中标题已命中 JD 黑名单时直接记录跳过，不打开详情、不做 OCR，也不等待详情采集间隔；标题未命中时仍检查完整 JD。清空输入可取消对应黑名单，先前仅检查标题的职位可在继续运行时重新采集；运行中需先暂停再修改。
10. 设置页「标题预筛」默认关闭：所有卡片直接打开详情采集评分。开启后每张卡片先按简历做一次标题预筛 LLM 请求，明显不符的直接跳过（不打开详情、不评分）；开关修改即时生效。
11. 侧栏可以隐藏，右侧 `J` 按钮可随时恢复。
12. BOSS 侧栏新增「自动回复消息」（默认关闭）。勾选后，在 `/web/geek/chat` 前台页点击「未读」，按本地规则自动打开明确拒绝 / 不合适的消息；对明确索要简历的消息，核对聊天对象与最新入站消息后，依次点击「发简历」→ 中文附件 →「发送」。不调用 LLM，其他消息保留未读。中文附件名须含独立的 `CN` / `zh-CN` / `Chinese` 标记，或「中文」「简体」，例如 `Sample-CV-cn.pdf`；找不到或存在多份中文附件时保留窗口供人工选择。发送尝试会持久化去重，结果未确认也不自动重发；已有简历发送 / 申请记录时跳过。隐藏标签页会等待，手动操作聊天区会暂停本页自动处理，重新切换复选框可恢复。聊天页也提供相同开关与状态，不依赖 Helper / 模型配置；多个聊天页只允许一个处理，加分项草稿处理期间自动让行。

BOSS 聊天页也可以直接点击浏览器工具栏的 JSeeker 图标 →「自动回复消息」开始，不需要先打开侧栏；已打开但没有聊天脚本的页面会自动补载。运行中再次打开弹窗，点击「停止自动回复」关闭；手动操作暂停后，弹窗会恢复显示「自动回复消息」，点击即可继续。更新版本后先在扩展管理页 Reload 已构建的 `dist/` 扩展。

聊天侧栏会显示扫描轮次、识别到的未读会话数量、拒绝 / 索要简历 / 其他消息分类和已处理计数。无法确认唯一联系人、页面结构未识别或简历窗口等待人工处理时会显示原因。BOSS 的未读数字按消息计数，可能大于识别到的未读会话数。

## 模型测速

运行 `npm run test:speed -- --help` 查看参数。默认以最新一条已采集 JD，依次测试 hello、真实 JD＋简历仅返回分数、完整生产提示流式、完整生产提示非流式，各重复两次。所有默认用例均使用 `reasoning_effort: low`、temperature=0、max_tokens=3000；模型和接口读取指定配置文件。

准备本地 `config.json`（不要提交凭据）：

```json
{
  "llm_base_url": "http://localhost:8321/v1",
  "llm_model": "glm-5.3-flash",
  "llm_api_key_override": "YOUR_LOCAL_KEY"
}
```

简历文件是含 `text` 字段的 JSON。使用已采集的真实 JD 和本地简历运行：

```bash
npm run test:speed -- --config /path/to/config.json --profile /path/to/profile.json \
  --jobs data/logs/jd-items.jsonl --job-id liepin:job:1986214177 \
  --repeats 2 --out artifacts/model-speed.json
```

省略 `--job-id` 则取日志中最新 JD；可用 `--cases production_stream_low,production_nonstream_low` 只比较完整场景，或通过 `--timeout-ms`、`--max-tokens` 调整预算。请求串行发送，不自动重试，完整场景复用当前生产提示和输入裁剪。测速会将指定 JD 和简历发送到配置的模型接口。

输出 JSON 保存每次调用的响应头、首个事件/推理/正文、完整返回耗时、token 用量、返回模型及应用校验结果；旁边自动生成 Markdown 汇总报告。凭据、简历全文和完整模型输出不进入报告。非流式无法测首 token；报告区分 HTTP 成功和业务结果有效，少量样本及缓存/服务负载会影响比较。

## 安装

```bash
npm ci
npm run build
npm run helper:build
```

在 `brave://extensions` 开启开发者模式，加载项目中的 `dist/`。不要加载 `extension/` 源码目录：其中的模块和 CSS 导入需要先构建。更新代码后重新运行 `npm run build`，点击扩展的 Reload，并刷新 BOSS 页面。若页面未出现侧栏，可点击工具栏 JSeeker →「打开匹配侧栏」，恢复隐藏的侧栏或向已打开的搜索列表页补载脚本。

## 本地简历

仓库不保存真实简历，涉及两个文件：

- `extension/profile.example.json` — 提交到仓库的合成示例，只用于说明 profile 结构；带 `"is_example": true` 标记，设置页会提示导入自己的简历。
- `extension/profile.local.json` — 你的真实简历，仅保存在本机，已写入 `.gitignore`，权限为 `0600`。仅在文件存在时，`npm run build` 才会把它复制到 `dist/`。

从命令行导入 Markdown 简历：

```bash
npm run import-cv -- /path/to/cv.md
```

也可以在扩展设置页粘贴或上传。两种方式都会先经 `redactCV` 移除电话、邮箱和个人链接，再写入存储或发送给模型。

首次运行时，扩展优先从 `profile.local.json` 初始化 `profile`，文件不存在时回退到 `profile.example.json`。**正式运行前请先导入自己的简历**，否则模型会对示例数据评分。

## `.env`

`npm run helper` 启动时优先读取仓库根目录的 `.env`，避免终端或宿主工具的同名环境变量覆盖项目配置：

```text
OPENAI_API_KEY=<redacted>
OPENAI_BASE_URL=<redacted>
```

可选的默认模型：

```text
OPENAI_MODEL=<model id>
```

未设置默认模型时，Helper 会按 Base URL 识别本地 Provider 目录，并采用与设置页一致的默认模型（例如 DeepSeek 的 `deepseek-flash`）。自定义、无法识别的 Base URL 仍需指定模型。

可选的模型超时，默认 120 秒：

```text
OPENAI_TIMEOUT_MS=120000
```

可选的模型输出预算，默认 3000 tokens：

```text
OPENAI_MAX_TOKENS=3000
```

真实 E2E 默认使用 `.env` 凭据。API Key 只在 Helper 进程内使用，不进入扩展页面、`dist/`、CSV、JSON 导出或日志。构建脚本会检查 `dist/` 是否意外包含 Key 值。

启动 Helper：

```bash
npm run helper
```

Helper 会将每次评分收到的完整 JD 追加到 `data/logs/jd-items.jsonl`（每行一条 JSON，包含时间、模型和 job 字段）。重启后继续追加；可通过 `.env` 中的 `JSEEKER_JD_LOG_PATH` 自定义路径。日志不包含简历或 API Key，路径会在启动时打印。黑名单等未发送给 Helper 评分的职位不会写入此日志。

首次使用时，扩展会与本地 Helper 自动配对，无需复制 Token。Helper 仅允许由当前项目 `dist/` 或 `extension/` 路径派生的扩展 ID 配对，并验证构建时写入扩展私有资源的本机配对凭据（根目录 `.helper-pairing-key` 和生成的 `helper-pairing.json` 文件均为 `0600`，不提交到 Git，不公开给网页）。请求仍使用 Token 校验；更换 Token 后会自动重新配对。Token 以本机 `0600` 文件和受信任扩展存储保存，不包含在构建产物中。更新此功能后需重启 Helper。旧版 Helper 或特殊安装目录仍可在“本地 Helper（高级）”手动填写连接 Token。生成的配对凭据仅供本机使用；分发项目时排除这些凭据文件，在目标机器重新构建。

## BYOK Provider 与 Model

设置页读取 [llm-provider-catalog.json](extension/llm-provider-catalog.json)：

- 列出 Chat Completions、OpenAI Responses 和 Anthropic Messages Provider；OpenAI 与 Anthropic (Claude) 可直接选择。
- Base URL 与目录匹配时自动选择 Provider。
- Provider 变化时自动联动 Base URL 和 Model 下拉。
- 无法匹配当前 Base URL 时使用 `Custom / .env`。
- REASONING 可选 Auto（沿用 GLM 5.3 为 low、其他模型由服务商决定）、Provider default（不发送推理强度）或 Low（显式发送低推理强度）。修改后旧评分会过期。

API Key 输入框可直接编辑：

- 没有已保存的自定义 Key 时，留空使用 Helper 从 `.env` 读取的 Key。
- 输入新 Key 后保存，会作为本地覆盖写入受信任扩展存储。
- 输入框不会回显已保存值；使用密码类型和状态占位符。
- 已保存自定义 Key 后，留空保存会保留该 Key；输入新 Key 可以覆盖。
- 切换 Provider 或 Base URL 时，旧 Provider 的本地 Key 会自动清除，避免把凭据发往另一个服务。

点击“保存设置”会自动检查 Helper 与模型配置，并更新上方 READY / ERROR 状态；结果同时同步到已打开的匹配侧栏。侧栏每次开始前也会重新读取配置。

选择与 `.env` 不匹配的 Provider 会使用该 Provider 的 Base URL。切换 Provider、Base URL 或 Model 后，旧 LLM 分数会标记为过期。

### LangSmith 性能追踪

在 `.env` 中设置 `LANGSMITH_TRACING=true`、`LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`，可选 `LANGSMITH_ENDPOINT`（默认 `https://api.smith.langchain.com`），然后重启 Helper。每次 `/evaluate` 评分会通过 OpenTelemetry OTLP 发送一条 LangSmith trace，记录模型、耗时、Prompt 版本、输入字符数、重试次数、评分、结论及服务商返回的 token 用量。Trace 不包含 JD、CV 或 API Key。打开 LangSmith 对应 Project 的 Tracing 页面查看；本地 Helper 的既有 timing 日志仍可用于排查请求。

默认优先选择目录中的 Flash/Lite/Mini 模型。当前 DeepSeek 配置推荐使用 `deepseek-flash`。LLM 输入包含最长约 5200 字符的 JD；16000 字符以内的 CV 完整发送，更长 CV 才筛选相关片段。输出为紧凑 JSON，保存能力匹配分、简短理由、原文证据及独立的硬性条件状态。语言等条件未见证据时标记 unknown，不混入能力分，并阻止自动沟通。GLM 5.3 系列评分显式使用 `reasoning_effort: low`，避免默认 max 推理耗时；理由和证据采用精简输出，保留完整 CV 与独立非技术准入条件。默认输出预算为 6000 tokens；输出被截断时会自动用更大预算重试一次。评分版本更新会使旧缓存失效；修改后需要重启 Helper、重载扩展并刷新页面。

## 运行

在项目目录执行 `./restart.sh`，会停止占用 Helper 端口（默认 `17373`，支持 `JSEEKER_PORT`）的进程，然后在前台启动 `npm run helper`；按 Ctrl+C 停止。

1. 打开 `https://www.zhipin.com/web/geek/jobs?city=101280600` 并确认城市与预设筛选。
2. 点击工具栏 JSeeker，进入“设置简历”。
3. 导入 CV，确认 Helper、Provider 和 Model 状态。
4. 回到 BOSS，确认左侧列表和右侧 ASCII 控制面板。
5. 在 `CITY FILTER` 中勾选一个或多个主要城市；默认深圳。
6. 输入运行数量；数值会实时保存。
7. 设置 Score 阈值，点击“开始”。
8. 运行中同一个按钮变成“暂停”。
9. 失败职位可以通过“重试失败”重新处理；已成功数据不会重复覆盖。
10. 新批次保留全局评分索引和已沟通记录。BOSS 检测到搜索范围变化时立即停止，保留原批次，需恢复原筛选或手动点击“新批次”；不会自动切到推荐页续跑。猎聘仍支持按当前筛选自动归档旧批次并继续。主动暂停、登录验证和网站限制仍暂停。

主界面不显示采集 JD 列表、维度评分、人工审核、OCR 控件或已沟通明细。CSV 导出包含评分、资格、申请状态、沟通时间和模型来源。

OCR 截图只在目标区域与右侧面板重叠时短暂隐藏面板；本地 Vision 识别期间面板保持可见。用户也可以随时隐藏整个侧栏，并通过页面右缘的 `J` 按钮恢复。模型请求超时或模型连续返回无效 JSON 时，会记录为该职位的评分失败，并继续处理其他职位；再次运行或“重试失败”会重新评分。

## 持久化

关键本地键：

```text
job_index       最近一次有效 LLM 分数，供左侧徽标和新批次复用
contacted_jobs  已进入沟通入口的职位，隐藏保存并用于去重
run             当前批次原始 JD、OCR 证据、分数和申请记录
evaluation_cache
```

同一条记录的缓存需要同时匹配：

- `job_id`
- JD 指纹
- CV 版本
- Provider / Base URL / Model / Prompt 版本

## 验证

```bash
npm test
npm run build
npm run test:auto-reply
npm run test:setup
npm run test:blacklist
npm run test:llm
npm run test:llm:mock
npm run test:ocr
npm run test:recovery
```

- `test:llm` 默认读取真实 `.env`，使用 BYOK 目录自动选择 Provider 与 Model，并在隔离 Chromium 中执行完整流程。
- `test:setup` 在隔离浏览器中验证自动配对、旧 Token 恢复、侧栏补载/恢复及源码目录的侧栏禁用状态，不调用模型、不进入沟通。可设置 `JSEEKER_TEST_BROWSER` 为本机 Brave 可执行文件路径。
- `test:ocr` 验证默认本地 OCR、PUA 薪资和后续 LLM 评分。
- `test:recovery` 验证错误职位 ID、失败记录和“重试失败”。

完整回归：

```bash
npm run verify
```

真实页面验收使用已登录的专用 Brave 配置，不使用未登录的临时配置。真实运行前应确认筛选条件、运行数量和 Score 阈值；自动申请会点击 BOSS 的“立即沟通”入口。

## 数据安全

- 不读取 Cookie，不调用 BOSS 非可见接口。
- 职位 URL 移除临时 `securityId`。
- CV 进入模型前移除电话、邮箱和个人链接。
- JD、CV 和偏好均作为不可信输入。
- 不自动填写或发送聊天消息（可选的加分项消息与自动回复功能均为显式开启）。
- 真实 E2E 输出只报告状态、模型 ID 和匹配分，不输出凭据。

### 猎聘流程

加载最新 `dist/` 扩展后，在 `https://c.liepin.com/` 登录首页打开侧栏，选择城市、评分门槛和达标目标，点击“开始”。后台逐个打开职位详情标签页，采集 JD 并调用同一 Helper 评分。低分继续查找；达标后点击主职位的“聊一聊”，确认结果后关闭受控详情标签页并返回列表。“继续聊”表示已经沟通，不重复点击，也不占用新的达标目标。

单个职位的硬性条件待核实、不满足条件、JD 不可读或模型重试失败，不再暂停整批：保存原因，跳过该职位并继续查找，且不占用达标目标。CSV 的申请状态与硬性条件列保留原因。模型声称的硬性条件必须能在当前 JD 找到原文，不能将简历里的英语/CET6 等信息当作职位要求。

BOSS 和猎聘侧栏均提供“允许追加加分项消息”复选框，默认关闭，暂停后可修改并保存。开启后，在新沟通成功且 JD 明确加分项与当前简历原文匹配时（BOSS 也支持已建立会话），填入“加分项多项也涉及，包括……等。”消息，最多列出七项有证据的匹配。逐条核对 JD 及其并列能力，以 JD 能力为主生成摘要，可综合 1–3 段简历原文，不要求摘要逐字出现在简历中。每种语言、特定工具、团队规模、sandbox、具体行业经历等须有对应证据，不因 JD 提及就补写。填入后保留未发送的草稿标签页，自动切回原列表并继续批次，无需人工发送或确认。已有文字不覆盖；无法核实会话或聊天框异常时记录原因、跳过本条加分项并继续，成功建立的沟通不会重试，状态保存在申请记录的 `bonus_draft`。BOSS 始终在独立的目标职位标签页内进行首次沟通、继续沟通和加分项填写；即使网站在当前页内跳转到聊天，也不会影响原列表。完成后只激活原列表，不重新打开列表 URL、不刷新或后退，保留原筛选和滚动位置；首次沟通和发送前再次核对原列表的批次范围。BOSS 聊天页未返回结果时最多等待 30 秒，之后记录超时并继续；刷新后清除旧版遗留的草稿等待状态。旁边的“自动发送”复选框默认关闭，需同时开启追加消息才可启用，并在暂停时修改、保存。关闭时只留草稿；开启时，在目标会话和输入内容核实后自动点击发送。猎聘确认加分项状态为 `sent` 后关闭任务详情标签页；草稿或发送未确认时保留，不关闭其他用户标签页。点击前持久记录单次授权；发送未确认时记为 `send_unconfirmed`，不重复发送，保留聊天页并继续批次。首次更新需执行 `./restart.sh`，重载扩展并刷新职位页，使新评分提示与开关一起生效；扩展会核对 Helper 的运行中评分提示版本，版本不符时明确要求重启，防止旧提示漏掉加分项；仅更新 BOSS 支持或等待确认流程时，重载扩展并刷新列表页即可。

BOSS 的“继续沟通”和本地已有沟通记录也可补写加分项：当前批次已采集且评分有效、尚无加分项草稿的职位，点击“开始”时会检查并打开已有会话，不再发送首次招呼。已经生成或人工确认过草稿的职位不重复处理。若评分未返回可由简历原文核实的加分项，侧栏会显示原因；总分达标本身不触发补写。BOSS 会先打开一个独立的目标职位详情页，登记该标签页后才允许它点击沟通；原列表内的沟通按钮不会用于加分项处理。网站打开新聊天页或在详情标签页内跳转均受支持，不通过通用联系人列表猜测接收人。普通、非任务所属的职位页和聊天页不会自动操作；已有文字不覆盖。草稿填写触发输入与失焦保存事件，发送前持久记录单次授权，未确认的发送不会重发。任务完成后只切回原列表，聊天页用于保留草稿；成功发送则关闭任务所属标签页。

详情加载失败会刷新该受控详情页重试一次；模型网络错误、超时、无效 JSON 或匹配分格式错误会再重试一次，仍失败则保存失败记录并继续。可点击“重试失败”重新处理；已沟通记录保留去重。运行中刷新列表页后会自动恢复尚未点击沟通的任务；扩展重启后刷新列表页也可从检查点恢复。猎聘刷新可能重置原生职位分类，分类与原批次不一致时会自动归档旧批次，按当前分类创建新批次并继续；历史评分和沟通记录保留。

遇到沟通上限、登录验证、未知弹窗、职位身份变化或未确认的沟通结果时，整个流程仍暂停并保留详情页。人工处理后，从原列表页继续；未确认的发送不会自动重发，用户主动暂停不会因刷新自动恢复。BOSS 搜索范围变化会停止，需人工确认筛选并新建批次；猎聘的搜索范围切换仍可自动开启新批次。历史评分和已沟通记录仍保留。

沟通限制仅依据当前可见的网站弹窗、警告或 toast 判断，不扫描整个 JD 或聊天历史。提示会区分“沟通上限”“操作频繁”“需要验证”，并附上网站提示原文；会员额度介绍不等同于额度用完。

猎聘支持 `/a/{id}.shtml` 和 `/job/{id}.shtml`，使用 `liepin:a:{id}` / `liepin:job:{id}` 作为去重键，忽略追踪参数。Helper JSONL 记录包括 `site`、`job_id`、规范 `url` 与 JD。

自动化 fixture 验证：`npm run build && npm run test:liepin`。该测试使用模拟页面和模型，不代替已登录 Brave 配置的真实网站 E2E 验收。

## 路线图

- [ ] **Glassdoor** 适配（`glassdoor.com`）：列表/详情解析、薪资归一化、Easy Apply/沟通流程。
- [ ] **Indeed** 适配（`indeed.com`）：列表/详情解析、薪资归一化、外部申请跳转处理。
- [ ] 集中站点注册表：新增网站只改一个模块，而不是同时修改 `sites.js`、`core.js`、`manifest.json`、`build.mjs` 和 `content.js`。
- [ ] 英文简历的通用联系方式脱敏（覆盖中国手机号之外的电话格式）。
- [ ] 每个新适配器先在脱敏 DOM fixture 上验证，再进行真实页面运行。

准备贡献其中之一？请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-job-site)，其中列出了适配器契约和需要修改的具体文件。
