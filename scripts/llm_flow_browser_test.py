"""End-to-end PLAN1 regression using the real credentials from .env."""

import asyncio
import json
import os
import re
import tempfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / "artifacts"
ART.mkdir(exist_ok=True)
MODEL_AUTHORIZATIONS = []


class ModelHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        MODEL_AUTHORIZATIONS.append(self.headers.get("Authorization"))
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "match_score": 95,
                                "verdict": "apply",
                                "summary": "Mock e2e match",
                                "strengths": ["Agent"],
                                "gaps": [],
                                "evidence": [],
                            }
                        )
                    }
                }
            ]
        }
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        text = line[7:] if line.startswith("export ") else line
        if "=" not in text:
            continue
        key, value = text.split("=", 1)
        value = value.strip()
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {'"', "'"}
        ):
            value = value[1:-1]
        values[key.strip()] = value
    return values


def normalized_base(value: str) -> str:
    return value.strip().rstrip("/")


def resolve_model(base_url: str, api_key: str) -> tuple[str, str]:
    catalog = json.loads(
        (ROOT / "extension/llm-provider-catalog.json").read_text()
    )
    target = normalized_base(base_url)
    target_url = urlparse(target)
    provider = None
    for item in catalog["providers"]:
        if item.get("protocol") != "openai_chat":
            continue
        candidates = [
            item.get("baseUrl", ""),
            *(item.get("endpointCandidates") or []),
        ]
        for candidate in candidates:
            source = urlparse(normalized_base(candidate))
            if (
                source.hostname == target_url.hostname
                and source.port == target_url.port
                and (
                    target_url.path.startswith(source.path)
                    or source.path.startswith(target_url.path)
                )
            ):
                provider = item
                break
        if provider:
            break
    if provider and provider.get("models"):
        model_id = next(
            (
                model["id"]
                for model in provider["models"]
                if re.search(r"flash|lite|mini|fast", model["id"], re.I)
            ),
            provider["models"][0]["id"],
        )
        return provider["id"], model_id

    endpoint = (
        target.rsplit("/chat/completions", 1)[0] + "/models"
        if target.endswith("/chat/completions")
        else target + "/models"
    )
    request = urllib.request.Request(
        endpoint,
        headers={"Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read())
    models = payload.get("data") or payload.get("models") or []
    ids = [
        item.get("id") or item.get("name")
        for item in models
        if item.get("id") or item.get("name")
    ]
    if not ids:
        raise RuntimeError("No model available for OPENAI_BASE_URL")
    return "", ids[0]


async def wait_for_run(worker, predicate, attempts=900):
    value = None
    for _ in range(attempts):
        value = await worker.evaluate(
            "async()=> await chrome.storage.local.get(['run','job_index','contacted_jobs'])"
        )
        if predicate(value):
            return value
        await asyncio.sleep(0.1)
    summary = value or {}
    run = summary.get("run") or {}
    raise AssertionError(
        "run condition timed out: "
        + json.dumps(
            {
                "run": {
                    "id": run.get("id"),
                    "status": run.get("status"),
                    "target": run.get("target"),
                    "job_ids": [
                        job.get("job_id") for job in run.get("jobs", [])
                    ],
                    "scores": run.get("scores"),
                    "score_failures": run.get("score_failures"),
                    "current": run.get("current"),
                    "stop_reason": run.get("stop_reason"),
                    "applications": run.get("applications"),
                },
                "contacted_ids": sorted((summary.get("contacted_jobs") or {}).keys()),
                "indexed_ids": sorted((summary.get("job_index") or {}).keys()),
            },
            ensure_ascii=False,
        )[:6000]
    )


async def main():
    use_mock = os.environ.get("JSEEKER_LLM_TEST_MODE") == "mock"
    model_server = None
    if use_mock:
        model_server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        threading.Thread(
            target=model_server.serve_forever,
            daemon=True,
        ).start()
        base_url = f"http://127.0.0.1:{model_server.server_address[1]}/v1"
        api_key = "plan1-ui-override-key"
        helper_api_key = "plan1-env-secret-key"
        provider_id = ""
        model = "plan1-mock-model"
    else:
        env = read_env(ROOT / ".env")
        base_url = env.get("OPENAI_BASE_URL", "")
        api_key = env.get("OPENAI_API_KEY", "")
        helper_api_key = api_key
        assert (
            base_url and api_key
        ), "OPENAI_BASE_URL and OPENAI_API_KEY are required"
        provider_id, model = resolve_model(base_url, api_key)
    token = "plan1-helper-token"
    helper_port = 17473

    helper_env = dict(os.environ)
    for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"):
        helper_env.pop(key, None)
    helper_env.update(
        {
            "JSEEKER_PORT": str(helper_port),
            "JSEEKER_TOKEN": token,
        }
    )
    if use_mock:
        helper_env.update(
            {
                "OPENAI_API_KEY": helper_api_key,
                "OPENAI_BASE_URL": base_url,
                "OPENAI_MODEL": model,
            }
        )
    helper = await asyncio.create_subprocess_exec(
        "node",
        "helper/server.mjs",
        cwd=ROOT,
        env=helper_env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        startup = await asyncio.wait_for(helper.stdout.readline(), 8)
        assert f"127.0.0.1:{helper_port}".encode() in startup
        with tempfile.TemporaryDirectory(prefix="jseeker-plan1-real-") as profile:
            fixture = (ROOT / "tests/fixture.html").read_text()
            fixture = fixture.replace("'-K'", "'30-50K·13薪'")
            async with async_playwright() as playwright:
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
                        body=fixture,
                    ),
                )
                worker = (
                    context.service_workers[0]
                    if context.service_workers
                    else await context.wait_for_event("serviceworker")
                )
                extension_id = worker.url.split("/")[2]

                options = await context.new_page()
                await options.goto(
                    f"chrome-extension://{extension_id}/options.html"
                )
                await options.evaluate(
                    "async port => chrome.storage.local.set({helper_port: port})",
                    helper_port,
                )
                await options.locator("details").evaluate(
                    "node => node.open = true"
                )
                assert await options.locator("#provider option").count() > 20
                await options.locator("#token").fill(token)
                await options.get_by_role(
                    "button",
                    name="保存连接 Token",
                    exact=True,
                ).click()
                if provider_id:
                    await expect(options.locator("#provider")).to_have_value(
                        provider_id
                    )
                await expect(options.locator("#model")).to_have_value(model)
                assert await options.locator("#api-key").is_editable()
                if use_mock:
                    await options.locator("#api-key").fill(api_key)
                await options.get_by_role(
                    "button", name="保存设置", exact=True
                ).click()
                await expect(options.locator("#llm-status")).to_contain_text(
                    "LLM      已配置"
                )
                await expect(options.locator("#api-key")).to_have_value("")
                if use_mock:
                    assert "已保存自定义 Key" in await options.locator(
                        "#api-key"
                    ).get_attribute("placeholder")
                else:
                    assert ".env Key 已配置" in await options.locator(
                        "#api-key"
                    ).get_attribute("placeholder")
                assert api_key not in await options.content()
                await options.screenshot(
                    path=str(ART / "plan1-options-real.png"),
                    full_page=True,
                )

                page = await context.new_page()
                page_errors = []
                page.on("pageerror", lambda error: page_errors.append(str(error)))
                await page.goto("https://www.zhipin.com/web/geek/jobs")
                await page.wait_for_selector("#jseeker-root", state="attached")
                await page.wait_for_selector(".more-job-btn")
                panel = page.locator("#jseeker-root").locator(".panel")
                assert await panel.is_visible()
                await page.get_by_label("隐藏 JSeeker 侧栏", exact=True).click()
                await expect(panel).to_be_hidden()
                await page.get_by_label("显示 JSeeker 侧栏", exact=True).click()
                await expect(panel).to_be_visible()
                shadow_text = await page.locator("#jseeker-root").evaluate(
                    "node => node.shadowRoot.querySelector('.body').innerText"
                )
                assert "SCORE FILTER" in shadow_text
                assert "RUN COUNT" in shadow_text
                for forbidden in [
                    "规则评分",
                    "AI 评价",
                    "设置运行数量",
                    "按匹配分",
                    "全部已采集职位",
                    "人工审核",
                ]:
                    assert forbidden not in shadow_text, forbidden
                await page.get_by_label("匹配阈值", exact=True).fill("60")
                await page.get_by_label("匹配阈值", exact=True).press("Tab")
                await page.get_by_label("运行数量", exact=True).fill("1")
                for _ in range(40):
                    saved = await worker.evaluate(
                        "async()=> await chrome.storage.local.get(['run_target','match_threshold'])"
                    )
                    if (
                        saved.get("run_target") == 1
                        and saved.get("match_threshold") == 60
                    ):
                        break
                    await asyncio.sleep(0.1)
                assert saved == {"run_target": 1, "match_threshold": 60}

                city_filter = page.locator("#jseeker-root").locator(
                    "details.city-filter"
                )
                await expect(city_filter).to_be_visible()
                await expect(city_filter.locator("summary")).to_contain_text(
                    "深圳"
                )
                await city_filter.locator("summary").click()
                await page.get_by_label("北京", exact=True).check()
                for _ in range(40):
                    selected_cities = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('selected_cities')).selected_cities"
                    )
                    if selected_cities == ["北京", "深圳"]:
                        break
                    await asyncio.sleep(0.1)
                assert selected_cities == ["北京", "深圳"]
                await page.get_by_label("北京", exact=True).uncheck()
                for _ in range(40):
                    selected_cities = await worker.evaluate(
                        "async()=> (await chrome.storage.local.get('selected_cities')).selected_cities"
                    )
                    if selected_cities == ["深圳"]:
                        break
                    await asyncio.sleep(0.1)
                assert selected_cities == ["深圳"]

                await page.get_by_role("button", name="开始", exact=True).click()
                await expect(
                    page.get_by_role("button", name="暂停", exact=True)
                ).to_be_visible(timeout=5000)
                await page.get_by_role("button", name="暂停", exact=True).click()
                state = await wait_for_run(
                    worker,
                    lambda value: value.get("run")
                    and value["run"].get("status") == "paused",
                    attempts=120,
                )
                assert state["run"]["status"] == "paused"

                await page.get_by_role("button", name="开始", exact=True).click()
                state = await wait_for_run(
                    worker,
                    lambda value: value.get("run")
                    and value["run"].get("scores", {}).get("job1")
                    and value.get("contacted_jobs", {})
                    .get("job1", {})
                    .get("status")
                    == "contact_opened",
                )
                run = state["run"]
                real_score = run["scores"]["job1"]["match_score"]
                assert 0 <= real_score <= 100
                assert await page.evaluate("window.fixture.cityPopups") == 1
                assert await page.evaluate("window.fixture.cityClicks") == 1
                assert run["scores"]["job1"]["engine"] == "llm"
                assert run["scores"]["job1"]["model"] == model
                assert state["job_index"]["job1"]["score"] == real_score
                assert state["contacted_jobs"]["job1"]["status"] == "contact_opened"
                assert await page.locator(
                    ".job-card-box .jseeker-badge"
                ).first.inner_text() == str(round(real_score))
                assert await page.evaluate(
                    "window.fixture.chatClicks + window.fixture.likeClicks"
                ) == 1
                assert await page.evaluate("window.fixture.defaultClicks") == 0
                assert await page.evaluate("window.fixture.dismissedDialogs") == 1
                if use_mock:
                    assert MODEL_AUTHORIZATIONS[-1] == f"Bearer {api_key}"

                async with page.expect_download() as pending:
                    await page.get_by_role(
                        "button", name="导出 CSV", exact=True
                    ).click()
                download = await pending.value
                csv_text = Path(await download.path()).read_text()
                assert "job_id" in csv_text and "contacted_at" in csv_text
                assert "job1" in csv_text and str(real_score) in csv_text
                assert api_key not in csv_text and token not in csv_text

                await page.get_by_role(
                    "button", name="新批次", exact=True
                ).click()
                await wait_for_run(
                    worker,
                    lambda value: value.get("run") is None,
                    attempts=80,
                )
                await page.get_by_role("button", name="开始", exact=True).click()
                state = await wait_for_run(
                    worker,
                    lambda value: value.get("run")
                    and value["run"].get("scores", {}).get("job2")
                    and value.get("contacted_jobs", {})
                    .get("job2", {})
                    .get("status")
                    == "contact_opened",
                )
                run = state["run"]
                assert [job["job_id"] for job in run["jobs"]] == ["job2"]
                assert set(state["contacted_jobs"]) == {"job1", "job2"}
                assert await page.evaluate("window.fixture.defaultClicks") == 0
                assert await page.evaluate("window.fixture.dismissedDialogs") == 2

                if use_mock:
                    await page.get_by_label("匹配阈值", exact=True).fill("100")
                    await page.get_by_label("匹配阈值", exact=True).press("Tab")
                    await page.get_by_role(
                        "button", name="新批次", exact=True
                    ).click()
                    await wait_for_run(
                        worker,
                        lambda value: value.get("run") is None,
                        attempts=80,
                    )
                    await expect(page.locator("#jseeker-root")).to_contain_text("新批次已创建")
                    run_count = page.get_by_label("运行数量", exact=True)
                    await run_count.fill("2")
                    for _ in range(40):
                        saved_target = await worker.evaluate(
                            "async()=> (await chrome.storage.local.get('run_target')).run_target"
                        )
                        if saved_target == 2:
                            break
                        await asyncio.sleep(0.1)
                    assert saved_target == 2
                    await expect(run_count).to_have_value("2")
                    await page.reload()
                    await page.wait_for_selector(
                        "#jseeker-root", state="attached"
                    )
                    await page.wait_for_selector(".more-job-btn")
                    # Low scores must exhaust a finite list, not complete at two JDs.
                    await page.evaluate(r"""() => {
                        for (const card of document.querySelectorAll('.job-card-box')) {
                            const id = card.querySelector('.job-name')?.getAttribute('href')?.match(/job(\d+)/)?.[1];
                            if (Number(id) > 5) card.remove();
                        }
                    }""")
                    await page.get_by_role(
                        "button", name="开始", exact=True
                    ).click()
                    state = await wait_for_run(
                        worker,
                        lambda value: value.get("run")
                        and value["run"].get("status") == "exhausted"
                        and set(
                            job["job_id"]
                            for job in value["run"].get("jobs", [])
                        )
                        == {"job4", "job5"},
                        attempts=400,
                    )
                    assert "job3" not in state["run"]["scores"]
                    assert state["run"]["city_filter"] == ["深圳"]
                    assert all(
                        score["match_score"] == 95
                        for score in state["run"]["scores"].values()
                    )
                    assert set(state["contacted_jobs"]) == {"job1", "job2"}
                assert not page_errors, page_errors
                await page.screenshot(
                    path=str(ART / "plan1-main-real.png"),
                    full_page=True,
                )
                report = {
                    "status": "passed",
                    "credential_source": "mock" if use_mock else ".env",
                    "provider_id": provider_id,
                    "model": model,
                    "job1_score": real_score,
                    "checks": [
                        (
                            "mock model transport used"
                            if use_mock
                            else "real .env credentials loaded by helper"
                        ),
                        (
                            "custom model selected for mock transport"
                            if use_mock
                            else "provider and model auto-selected from BYOK catalog"
                        ),
                        "default panel visible",
                        "sidebar hide and restore controls",
                        "ASCII controls rendered",
                        "multi-city allowlist skips non-matching cards",
                        "single start/pause toggle",
                        "run threshold and count live-saved",
                        "LLM score written to run and job index",
                        "left-side score badge",
                        "automatic contact entry recorded and not repeated",
                        "new batch skips previously collected and contacted job",
                        *(
                            ["below-threshold job continues to the next JD"]
                            if use_mock
                            else []
                        ),
                        "CSV includes audit fields without secrets",
                    ],
                    "csv_download": download.suggested_filename,
                }
                (ART / "plan1-real-browser-report.json").write_text(
                    json.dumps(report, ensure_ascii=False, indent=2)
                )
                print(json.dumps(report, ensure_ascii=False))
                await context.close()
    finally:
        if helper.returncode is None:
            helper.terminate()
        await helper.wait()
        if model_server:
            model_server.shutdown()
            model_server.server_close()


asyncio.run(main())
