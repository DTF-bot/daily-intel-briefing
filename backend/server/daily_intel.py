import asyncio
import html
import json
import logging
import os
import re
import smtplib
from datetime import datetime, time as datetime_time, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field

from gpt_researcher.utils.enum import Tone
from server.server_utils import generate_report_files, sanitize_filename
from server.websocket_manager import run_agent

logger = logging.getLogger(__name__)

DATA_DIR = Path("data")
JOBS_PATH = DATA_DIR / "daily_intel_jobs.json"
RUNS_PATH = DATA_DIR / "daily_intel_runs.json"

CATEGORY_LABELS = {
    "news": "新闻",
    "funding": "融资",
    "product": "产品发布",
    "tech_blog": "技术博客",
    "industry": "行业动态",
}

REPORT_SECTION_TITLES = [
    "今日摘要",
    "分类情报",
    "重点公司/产品动态",
    "商业信号",
    "技术方向与产品趋势",
    "风险、不确定性和待跟踪事项",
    "来源链接",
]


class DailyIntelJobInput(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1)
    targets: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    source_categories: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)
    schedule_time: str = "09:00"
    time_window_days: int = 7
    enabled: bool = True
    email_recipients: list[str] = Field(default_factory=list)
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    smtp_use_tls: bool = True


class DailyIntelStore:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._ensure_file(JOBS_PATH)
        self._ensure_file(RUNS_PATH)

    def _ensure_file(self, path: Path) -> None:
        if not path.exists():
            path.write_text("[]", encoding="utf-8")

    async def list_jobs(self) -> list[dict[str, Any]]:
        async with self._lock:
            return self._read_json(JOBS_PATH)

    async def upsert_job(self, payload: DailyIntelJobInput, job_id: str | None = None) -> dict[str, Any]:
        async with self._lock:
            jobs = self._read_json(JOBS_PATH)
            now = datetime.now()
            normalized_schedule = normalize_schedule_time(payload.schedule_time)
            target_id = job_id or payload.id
            job = {
                "id": target_id or uuid4().hex,
                "name": payload.name.strip(),
                "targets": clean_list(payload.targets),
                "keywords": clean_list(payload.keywords),
                "source_categories": normalize_categories(payload.source_categories),
                "domains": clean_list(payload.domains),
                "schedule_time": normalized_schedule,
                "time_window_days": normalize_time_window_days(payload.time_window_days),
                "enabled": payload.enabled,
                "email_recipients": clean_list(payload.email_recipients),
                "smtp_host": payload.smtp_host.strip(),
                "smtp_port": payload.smtp_port,
                "smtp_username": payload.smtp_username.strip(),
                "smtp_password": payload.smtp_password,
                "smtp_from": payload.smtp_from.strip(),
                "smtp_use_tls": payload.smtp_use_tls,
                "last_run_at": None,
                "next_run_at": calculate_next_run_at(normalized_schedule, now).isoformat(),
            }
            if target_id:
                existing_index = next((index for index, item in enumerate(jobs) if item.get("id") == target_id), None)
                if existing_index is not None:
                    existing = jobs[existing_index]
                    job["last_run_at"] = existing.get("last_run_at")
                    if not job["smtp_password"]:
                        job["smtp_password"] = existing.get("smtp_password", "")
                    jobs[existing_index] = job
                else:
                    jobs.append(job)
            else:
                jobs.append(job)
            self._write_json(JOBS_PATH, jobs)
            return job

    async def delete_job(self, job_id: str) -> bool:
        async with self._lock:
            jobs = self._read_json(JOBS_PATH)
            remaining = [job for job in jobs if job.get("id") != job_id]
            if len(remaining) == len(jobs):
                return False
            self._write_json(JOBS_PATH, remaining)
            return True

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        jobs = await self.list_jobs()
        return next((job for job in jobs if job.get("id") == job_id), None)

    async def update_job_after_run(self, job_id: str, when: datetime) -> None:
        async with self._lock:
            jobs = self._read_json(JOBS_PATH)
            for job in jobs:
                if job.get("id") == job_id:
                    job["last_run_at"] = when.isoformat()
                    job["next_run_at"] = calculate_next_run_at(job.get("schedule_time", "09:00"), when).isoformat()
                    break
            self._write_json(JOBS_PATH, jobs)

    async def list_runs(self) -> list[dict[str, Any]]:
        async with self._lock:
            runs = self._read_json(RUNS_PATH)
            return sorted(runs, key=lambda item: item.get("started_at", ""), reverse=True)

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        runs = await self.list_runs()
        return next((run for run in runs if run.get("id") == run_id), None)

    async def append_run(self, run: dict[str, Any]) -> None:
        async with self._lock:
            runs = self._read_json(RUNS_PATH)
            runs.insert(0, run)
            self._write_json(RUNS_PATH, runs[:200])

    async def upsert_run(self, run: dict[str, Any]) -> None:
        async with self._lock:
            runs = self._read_json(RUNS_PATH)
            run_id = run.get("id")
            existing_index = next((index for index, item in enumerate(runs) if item.get("id") == run_id), None)
            if existing_index is None:
                runs.insert(0, run)
            else:
                runs[existing_index] = {**runs[existing_index], **run}
            self._write_json(RUNS_PATH, runs[:200])

    def _read_json(self, path: Path) -> list[dict[str, Any]]:
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "[]")
            return data if isinstance(data, list) else []
        except json.JSONDecodeError:
            logger.warning("Resetting invalid JSON store: %s", path)
            return []

    def _write_json(self, path: Path, data: list[dict[str, Any]]) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


store = DailyIntelStore()
_scheduler_task: asyncio.Task | None = None
_running_jobs: set[str] = set()


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    safe_job = dict(job)
    safe_job["smtp_password_configured"] = bool(safe_job.get("smtp_password"))
    safe_job["smtp_password"] = ""
    return safe_job


def clean_list(values: list[str]) -> list[str]:
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def normalize_categories(values: list[str]) -> list[str]:
    categories = [item for item in clean_list(values) if item in CATEGORY_LABELS]
    return categories or list(CATEGORY_LABELS.keys())


def normalize_schedule_time(value: str) -> str:
    try:
        parsed = datetime.strptime(value, "%H:%M")
        return parsed.strftime("%H:%M")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="schedule_time must use HH:MM format") from exc


def normalize_time_window_days(value: int | str | None) -> int:
    try:
        days = int(value or 7)
    except (TypeError, ValueError):
        days = 7
    if days <= 1:
        return 1
    if days <= 3:
        return 3
    if days <= 7:
        return 7
    return 30


def build_recent_search_hints(job: dict[str, Any], start_date: datetime, end_date: datetime) -> str:
    targets = clean_list(job.get("targets") or []) or [str(job.get("name") or "行业动态")]
    keywords = clean_list(job.get("keywords") or []) or ["发布", "融资", "产品", "技术博客", "行业动态"]
    date_terms = [
        end_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y年%m月%d日"),
        f"最近{normalize_time_window_days(job.get('time_window_days', 7))}天",
    ]
    hints: list[str] = []
    for target in targets[:6]:
        joined_keywords = " OR ".join(keywords[:8])
        hints.append(f'"{target}" ({joined_keywords}) {" OR ".join(date_terms)}')
    domains = clean_list(job.get("domains") or [])
    if domains:
        hints.append("限定域名检索：" + " OR ".join(f"site:{domain}" for domain in domains[:8]))
    return "\n".join(f"- {hint}" for hint in hints)


def calculate_next_run_at(schedule_time: str, now: datetime | None = None) -> datetime:
    now = now or datetime.now()
    normalized = normalize_schedule_time(schedule_time)
    hour, minute = [int(part) for part in normalized.split(":")]
    candidate = datetime.combine(now.date(), datetime_time(hour=hour, minute=minute))
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def build_daily_intel_prompt(job: dict[str, Any]) -> str:
    today = datetime.now()
    today_text = today.strftime("%Y-%m-%d")
    time_window_days = normalize_time_window_days(job.get("time_window_days", 7))
    recent_start_text = (today - timedelta(days=time_window_days)).strftime("%Y-%m-%d")
    recent_start = today - timedelta(days=time_window_days)
    categories = job.get("source_categories") or list(CATEGORY_LABELS.keys())
    category_text = "、".join(CATEGORY_LABELS.get(item, item) for item in categories)
    category_sections = "\n".join(f"### {CATEGORY_LABELS.get(item, item)}" for item in categories)
    excluded_categories = [label for key, label in CATEGORY_LABELS.items() if key not in categories]
    excluded_text = "、".join(excluded_categories) if excluded_categories else "无"
    domains = job.get("domains") or []
    domain_text = "、".join(domains) if domains else "不限域名，优先选择高可信公开来源"
    target_text = "、".join(job.get("targets") or []) or job.get("name", "目标公司/产品")
    keyword_text = "、".join(job.get("keywords") or []) or "发布、产品、技术、行业动态"
    previous_context = build_previous_run_context(job)
    search_hints = build_recent_search_hints(job, recent_start, today)

    return f"""请作为“每日情报速递”分析助手，抓取和总结公开可访问的公司、产品与行业信息。

监控名称：{job.get("name", "每日情报速递")}
目标公司/产品：{target_text}
关键词：{keyword_text}
来源分类：{category_text}
不需要输出的分类：{excluded_text}
限定域名：{domain_text}
当前日期：{today_text}
近期窗口：优先使用 {recent_start_text} 至 {today_text} 之间发布或更新的信息；“今日摘要”优先使用最近 24 小时的信息。
建议检索式：
{search_hints}
历史上下文与去重参考：
{previous_context}

边界要求：
- 只使用公开可访问来源。
- 不抓取登录、验证码、付费墙之后的内容。
- 不绕过反爬限制，不要求用户提供平台账号。
- 不虚构来源；不确定的信息必须标注“不确定”。
- 每条重要信息尽量带来源链接。
- 整份报告必须使用中文输出；英文来源标题、公司名、产品名可以保留原文。
- “分类情报”下面只能输出已选择的分类小标题，不要输出未选择的分类。

时效性要求：
- 检索和判断时必须优先按发布时间、更新时间排序，优先选择最近 24 小时，其次最近 7 天的信息。
- 搜索 query 必须显式包含当前年份、日期范围或“最近/今日/本周”等时间限定词；如果搜索结果无日期，必须降低权重。
- 超出近期窗口的资料只能作为背景材料，不能作为“今日摘要”“分类情报”的主要依据。
- 如果某条信息不是近期发布或近期更新，必须明确标注“背景资料”或“不确定”，并说明它不是今日动态。
- 如果近期没有可靠公开信息，不要用旧材料凑数；请写“未发现近期可靠公开动态”，并列出后续待跟踪方向。
- 来源链接旁尽量标注发布日期或更新时间；无法确认日期时标注“日期不确定”。
- 对历史上下文中已出现过的链接和事项做去重；只有出现新增事实、进展或权威来源更新时才重复提及。
- 和上次运行相比，尽量标注“新增”“延续”“未发现新增”“待跟踪”。

请严格使用以下报告结构：

# 每日情报速递

## 今日摘要

## 分类情报

{category_sections}

## 重点公司/产品动态

## 商业信号

## 技术方向与产品趋势

## 风险、不确定性和待跟踪事项

## 来源链接
"""


def create_initial_run(job: dict[str, Any], started_at: datetime) -> dict[str, Any]:
    return {
        "id": uuid4().hex,
        "job_id": job["id"],
        "job_name": job["name"],
        "status": "queued",
        "stage": "queued",
        "stage_message": "任务已创建，等待开始生成。",
        "started_at": started_at.isoformat(),
        "finished_at": None,
        "report_path": None,
        "report_url": None,
        "summary": "",
        "push_status": "skipped",
        "error": None,
        "progress_events": [
            {
                "at": started_at.isoformat(),
                "stage": "queued",
                "message": "任务已创建，等待开始生成。",
            }
        ],
    }


async def update_run_progress(run: dict[str, Any], stage: str, message: str, status: str | None = None) -> None:
    now_text = datetime.now().isoformat()
    run["stage"] = stage
    run["stage_message"] = message
    if status:
        run["status"] = status
    events = run.setdefault("progress_events", [])
    events.append({"at": now_text, "stage": stage, "message": message})
    run["progress_events"] = events[-30:]
    await store.upsert_run(run)


async def run_daily_intel_job(job_id: str, run: dict[str, Any] | None = None) -> dict[str, Any]:
    job = await store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Daily intel job not found")
    if job_id in _running_jobs and run is None:
        raise HTTPException(status_code=409, detail="Daily intel job is already running")

    _running_jobs.add(job_id)
    started_at = datetime.now()
    run = run or create_initial_run(job, started_at)
    await update_run_progress(run, "starting", "正在准备检索条件和日期窗口。", "running")

    try:
        await update_run_progress(run, "prompt", "正在构造带日期限制的每日情报检索任务。")
        prompt = build_daily_intel_prompt(job)
        await update_run_progress(run, "researching", "正在搜索公开网页并生成中文情报报告，这一步通常最耗时。")
        report = await run_agent(
            task=prompt,
            report_type="research_report",
            report_source="web",
            source_urls=[],
            document_urls=[],
            tone=Tone.Analytical,
            websocket=None,
            headers={},
            query_domains=job.get("domains") or [],
            config_path=os.environ.get("CONFIG_PATH", "default"),
            max_search_results=8,
        )
        await update_run_progress(run, "filtering", "正在按订阅日期窗口过滤旧动态和过期信息。")
        report = enforce_report_time_window(str(report), job)
        await update_run_progress(run, "exporting", "正在生成 Markdown、Word 和 PDF 报告文件。")
        filename = sanitize_filename(f"task_{int(started_at.timestamp())}_{job['name']}_daily_intel")
        file_paths = await generate_report_files(str(report), filename)
        md_path = file_paths.get("md")

        run["report_path"] = md_path
        run["report_url"] = f"/{md_path.replace(os.sep, '/')}" if md_path else None
        run["summary"] = extract_summary(str(report))
        quality = evaluate_report_quality(str(report), job)
        run["quality_score"] = quality["score"]
        run["quality_summary"] = quality["summary"]
        run["source_count"] = quality["source_count"]
        run["duplicate_link_count"] = quality["duplicate_link_count"]
        run["filtered_old_item_count"] = quality.get("filtered_old_item_count", 0)
        await update_run_progress(run, "pushing", "报告已生成，正在处理邮件推送。")
        run["push_status"] = await push_email_summary(job, run, str(report))
        run["status"] = "success"
        await update_run_progress(run, "completed", "运行完成。", "success")
    except Exception as exc:
        logger.exception("Daily intel run failed")
        run["error"] = str(exc)
        await update_run_progress(run, "failed", f"运行失败：{exc}", "failed")
    finally:
        finished_at = datetime.now()
        run["finished_at"] = finished_at.isoformat()
        await store.upsert_run(run)
        await store.update_job_after_run(job_id, finished_at)
        _running_jobs.discard(job_id)

    return run


async def start_daily_intel_job(job_id: str) -> dict[str, Any]:
    job = await store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Daily intel job not found")
    if job_id in _running_jobs:
        raise HTTPException(status_code=409, detail="Daily intel job is already running")
    _running_jobs.add(job_id)
    run = create_initial_run(job, datetime.now())
    await store.upsert_run(run)
    asyncio.create_task(run_daily_intel_job(job_id, run))
    return run


def build_previous_run_context(job: dict[str, Any]) -> str:
    runs = store._read_json(RUNS_PATH)
    related_runs = [
        run for run in runs
        if run.get("job_id") == job.get("id") and run.get("status") == "success"
    ][:3]
    if not related_runs:
        return "- 暂无历史运行记录。"

    lines = []
    seen_links: set[str] = set()
    for run in related_runs:
        links = extract_links_from_run(run)
        seen_links.update(links)
        summary = clean_markdown_for_email(str(run.get("summary") or ""))[:400]
        lines.append(
            f"- 上次运行：{run.get('finished_at') or run.get('started_at')}；"
            f"质量分：{run.get('quality_score', '未评分')}；摘要：{summary or '无摘要'}"
        )
    if seen_links:
        lines.append("- 历史已报道链接，除非有新进展请不要重复作为今日重点：")
        lines.extend(f"  - {link}" for link in sorted(seen_links)[:20])
    return "\n".join(lines)


def extract_links_from_run(run: dict[str, Any]) -> set[str]:
    links: set[str] = set(re.findall(r"https?://[^\s)）\\]]+", str(run.get("summary") or "")))
    report_path = run.get("report_path")
    if report_path:
        path = Path(str(report_path))
        if path.exists():
            try:
                links.update(re.findall(r"https?://[^\s)）\\]]+", path.read_text(encoding="utf-8", errors="ignore")))
            except OSError:
                pass
    return links


def extract_line_dates(text: str) -> list[datetime]:
    dates: list[datetime] = []
    patterns = [
        r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?",
        r"(\d{1,2})月(\d{1,2})日",
    ]
    current_year = datetime.now().year
    for match in re.finditer(patterns[0], text):
        try:
            dates.append(datetime(int(match.group(1)), int(match.group(2)), int(match.group(3))))
        except ValueError:
            continue
    for match in re.finditer(patterns[1], text):
        try:
            dates.append(datetime(current_year, int(match.group(1)), int(match.group(2))))
        except ValueError:
            continue
    return dates


def line_is_old_for_window(line: str, window_start: datetime) -> bool:
    dates = extract_line_dates(line)
    return bool(dates and max(dates) < window_start)


def enforce_report_time_window(report: str, job: dict[str, Any]) -> str:
    window_days = normalize_time_window_days(job.get("time_window_days", 7))
    window_start = datetime.now() - timedelta(days=window_days)
    strict_sections = {"今日摘要", "分类情报"}
    current_section = ""
    filtered_count = 0
    output: list[str] = []

    for raw_line in report.splitlines():
        section_match = re.match(r"^##\s+(.+?)\s*$", raw_line.strip())
        if section_match:
            current_section = section_match.group(1).strip()
            output.append(raw_line)
            continue
        if current_section in strict_sections and line_is_old_for_window(raw_line, window_start):
            filtered_count += 1
            continue
        output.append(raw_line)

    filtered_report = "\n".join(output).strip()
    if filtered_count:
        note = (
            "\n\n## 时效过滤说明\n\n"
            f"- 已自动过滤 {filtered_count} 条明显早于最近 {window_days} 天窗口的旧动态。"
            "- 旧资料只应作为背景，不应进入今日摘要或分类情报。"
        )
        if "## 时效过滤说明" not in filtered_report:
            filtered_report = f"{filtered_report}{note}"
    return filtered_report


def evaluate_report_quality(report: str, job: dict[str, Any]) -> dict[str, Any]:
    links = re.findall(r"https?://[^\s)）\\]]+", report)
    unique_links = set(links)
    duplicate_count = max(0, len(links) - len(unique_links))
    filtered_old_item_count = 0
    filter_match = re.search(r"已自动过滤\s+(\d+)\s+条", report)
    if filter_match:
        filtered_old_item_count = int(filter_match.group(1))
    sections = extract_report_sections(report)
    score = 100
    notes: list[str] = []

    if len(unique_links) < 3:
        score -= 25
        notes.append("来源链接偏少")
    if not sections.get("今日摘要"):
        score -= 15
        notes.append("缺少今日摘要")
    missing_sections = [title for title in REPORT_SECTION_TITLES if not sections.get(title)]
    if missing_sections:
        score -= min(20, len(missing_sections) * 4)
        notes.append("部分章节内容不足")
    if duplicate_count:
        score -= min(15, duplicate_count * 3)
        notes.append("存在重复链接")
    if re.search(r"202[0-5]年|202[0-5]-", report):
        score -= 15
        notes.append("包含较旧时间信息，请确认是否仅作为背景")
    if filtered_old_item_count:
        score -= min(10, filtered_old_item_count * 2)
        notes.append(f"已过滤旧动态 {filtered_old_item_count} 条")
    if "不确定" not in report and "日期不确定" in report:
        score -= 5

    score = max(0, min(100, score))
    summary = "；".join(notes) if notes else "来源、结构和时效性基本符合要求"
    return {
        "score": score,
        "summary": summary,
        "source_count": len(unique_links),
        "duplicate_link_count": duplicate_count,
        "filtered_old_item_count": filtered_old_item_count,
    }


def extract_summary(report: str) -> str:
    sections = extract_report_sections(report)
    preferred_titles = ["今日摘要", "分类情报", "重点公司/产品动态", "商业信号", "风险、不确定性和待跟踪事项"]
    chunks: list[str] = []
    for title in preferred_titles:
        body = sections.get(title)
        if body:
            chunks.append(f"{title}\n{clean_markdown_for_email(body)}")
    if not chunks:
        lines = [clean_markdown_for_email(line.strip()) for line in report.splitlines() if line.strip()]
        chunks = [line for line in lines if line and not line.startswith("#")][:12]
    return "\n\n".join(chunks)[:5000] or "本次运行已生成每日情报速递报告。"


async def push_email_summary(job: dict[str, Any], run: dict[str, Any], report: str = "") -> str:
    recipients = clean_list(job.get("email_recipients") or [])
    if not recipients:
        return "skipped"

    smtp_host = str(job.get("smtp_host") or "").strip()
    smtp_port = int(job.get("smtp_port") or 587)
    smtp_username = str(job.get("smtp_username") or "").strip()
    smtp_password = str(job.get("smtp_password") or "")
    smtp_from = str(job.get("smtp_from") or smtp_username).strip()
    smtp_use_tls = bool(job.get("smtp_use_tls", True))

    if not smtp_host or not smtp_from:
        logger.warning("Email push failed because SMTP host or sender is not configured")
        return "failed"

    subject = f"每日情报速递 - {run['job_name']}"
    content = build_email_text(job, run, report)
    html_content = build_email_html(job, run, report)

    try:
        await asyncio.to_thread(
            send_email_message,
            smtp_host,
            smtp_port,
            smtp_username,
            smtp_password,
            smtp_from,
            recipients,
            subject,
            content[:8000],
            html_content[:20000],
            smtp_use_tls,
        )
        return "success"
    except Exception as exc:
        logger.warning("Email push request failed: %s", exc)
        return "failed"


def send_email_message(
    smtp_host: str,
    smtp_port: int,
    smtp_username: str,
    smtp_password: str,
    smtp_from: str,
    recipients: list[str],
    subject: str,
    content: str,
    html_content: str,
    smtp_use_tls: bool,
) -> None:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = smtp_from
    message["To"] = ", ".join(recipients)
    message.set_content(content)
    if html_content:
        message.add_alternative(html_content, subtype="html")

    with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as smtp:
        if smtp_use_tls:
            smtp.starttls()
        if smtp_username and smtp_password:
            smtp.login(smtp_username, smtp_password)
        smtp.send_message(message)


def extract_report_sections(report: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {}
    current_title = ""
    for raw_line in report.splitlines():
        line = raw_line.rstrip()
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            current_title = match.group(1).strip()
            sections.setdefault(current_title, [])
            continue
        if current_title:
            sections[current_title].append(line)
    return {title: "\n".join(lines).strip() for title, lines in sections.items() if "\n".join(lines).strip()}


def clean_markdown_for_email(text: str) -> str:
    cleaned = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    cleaned = re.sub(r"__(.*?)__", r"\1", cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"^\s{0,3}#{1,6}\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"^\s*[-*]\s+", "- ", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def build_email_text(job: dict[str, Any], run: dict[str, Any], report: str) -> str:
    summary = extract_summary(report) if report else run.get("summary") or "报告已生成。"
    return (
        f"每日情报速递\n"
        f"监控：{run['job_name']}\n"
        f"生成时间：{run.get('finished_at') or run.get('started_at')}\n"
        f"质量评分：{run.get('quality_score', '-')} / 100（{run.get('quality_summary', '未评分')}）\n\n"
        f"{summary}\n\n"
        f"查看完整报告：{run.get('report_url') or '暂无报告链接'}"
    )


def build_email_html(job: dict[str, Any], run: dict[str, Any], report: str) -> str:
    sections = extract_report_sections(report)
    selected_titles = ["今日摘要", "分类情报", "重点公司/产品动态", "商业信号", "技术方向与产品趋势", "风险、不确定性和待跟踪事项"]
    body_parts: list[str] = []

    for title in selected_titles:
        body = sections.get(title)
        if not body:
            continue
        body_parts.append(
            f"<section>"
            f"<h2>{html.escape(title)}</h2>"
            f"{markdown_fragment_to_html(body)}"
            f"</section>"
        )

    if not body_parts:
        body_parts.append(f"<section><p>{html.escape(run.get('summary') or '报告已生成。')}</p></section>")

    report_url = run.get("report_url") or ""
    report_link = (
        f'<p class="report-link">完整报告：<a href="{html.escape(report_url)}">{html.escape(report_url)}</a></p>'
        if report_url
        else '<p class="report-link">完整报告：暂无报告链接</p>'
    )
    quality_text = html.escape(f"{run.get('quality_score', '-')} / 100（{run.get('quality_summary', '未评分')}）")

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ margin: 0; padding: 24px; background: #f6f7f9; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; line-height: 1.75; }}
    .container {{ max-width: 840px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 28px; }}
    h1 {{ margin: 0 0 8px; font-size: 24px; line-height: 1.35; }}
    .meta {{ margin: 0 0 24px; color: #6b7280; font-size: 14px; }}
    h2 {{ margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; font-size: 18px; }}
    h3 {{ margin: 20px 0 8px; font-size: 16px; }}
    p {{ margin: 10px 0; }}
    ul {{ margin: 10px 0 10px 22px; padding: 0; }}
    li {{ margin: 8px 0; }}
    a {{ color: #2563eb; text-decoration: none; }}
    .report-link {{ margin-top: 28px; padding-top: 16px; border-top: 1px solid #e5e7eb; color: #374151; }}
  </style>
</head>
<body>
  <div class="container">
    <h1>每日情报速递</h1>
    <p class="meta">监控：{html.escape(str(run['job_name']))} · 生成时间：{html.escape(str(run.get('finished_at') or run.get('started_at') or ''))} · 质量评分：{quality_text}</p>
    {''.join(body_parts)}
    {report_link}
  </div>
</body>
</html>"""


def markdown_fragment_to_html(markdown: str) -> str:
    blocks: list[str] = []
    list_items: list[str] = []

    def flush_list() -> None:
        if list_items:
            blocks.append("<ul>" + "".join(list_items) + "</ul>")
            list_items.clear()

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line:
            flush_list()
            continue
        heading = re.match(r"^###\s+(.+)$", line)
        if heading:
            flush_list()
            blocks.append(f"<h3>{inline_markdown_to_html(heading.group(1))}</h3>")
            continue
        bullet = re.match(r"^[-*]\s+(.+)$", line)
        if bullet:
            list_items.append(f"<li>{inline_markdown_to_html(bullet.group(1))}</li>")
            continue
        flush_list()
        blocks.append(f"<p>{inline_markdown_to_html(line)}</p>")
    flush_list()
    return "".join(blocks)


def inline_markdown_to_html(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"\*\*(.*?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"__(.*?)__", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(
        r"(https?://[^\s<]+)",
        r'<a href="\1">\1</a>',
        escaped,
    )
    return escaped


async def build_report_detail_html(run_id: str) -> str:
    run = await store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Daily intel run not found")

    report = ""
    report_path = run.get("report_path")
    if report_path:
        path = Path(str(report_path))
        if path.exists():
            report = path.read_text(encoding="utf-8", errors="ignore")

    sections = extract_report_sections(report)
    nav_items = "".join(
        f'<a href="#{html.escape(title)}">{html.escape(title)}</a>'
        for title in REPORT_SECTION_TITLES
        if sections.get(title)
    )
    body_parts: list[str] = []
    for title in REPORT_SECTION_TITLES:
        body = sections.get(title)
        if body:
            body_parts.append(
                f'<section id="{html.escape(title)}"><h2>{html.escape(title)}</h2>{markdown_fragment_to_html(body)}</section>'
            )
    if not body_parts:
        body_parts.append(f"<section><pre>{html.escape(report or run.get('summary') or '暂无报告内容')}</pre></section>")

    markdown_link = run.get("report_url") or ""
    markdown_button = f'<a href="{html.escape(markdown_link)}">查看 Markdown 原文</a>' if markdown_link else ""
    quality_text = html.escape(f"{run.get('quality_score', '-')} / 100（{run.get('quality_summary', '未评分')}）")
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>每日情报速递 - {html.escape(str(run.get('job_name') or '报告详情'))}</title>
  <style>
    body {{ margin: 0; background: #f7fafc; color: #102033; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", Arial, sans-serif; line-height: 1.8; }}
    .shell {{ display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 28px; max-width: 1180px; margin: 0 auto; padding: 32px 24px; }}
    aside {{ position: sticky; top: 24px; align-self: start; background: #fff; border: 1px solid #dbe7ef; border-radius: 8px; padding: 18px; }}
    aside a {{ display: block; color: #0f766e; text-decoration: none; margin: 8px 0; font-weight: 700; }}
    main {{ background: #fff; border: 1px solid #dbe7ef; border-radius: 8px; padding: 28px; }}
    h1 {{ margin: 0 0 8px; font-size: 28px; }}
    .meta {{ color: #64748b; margin-bottom: 24px; }}
    h2 {{ border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-top: 30px; }}
    h3 {{ margin-top: 22px; }}
    li {{ margin: 8px 0; }}
    a {{ color: #2563eb; }}
    .toolbar {{ margin: 18px 0 4px; display: flex; gap: 10px; flex-wrap: wrap; }}
    .toolbar a {{ border: 1px solid #99f6e4; border-radius: 6px; padding: 8px 12px; color: #0f766e; text-decoration: none; font-weight: 800; }}
    pre {{ white-space: pre-wrap; word-break: break-word; }}
    @media (max-width: 820px) {{ .shell {{ grid-template-columns: 1fr; }} aside {{ position: static; }} }}
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <strong>报告目录</strong>
      {nav_items or '<p>暂无目录</p>'}
    </aside>
    <main>
      <h1>每日情报速递</h1>
      <p class="meta">监控：{html.escape(str(run.get('job_name') or '未命名'))} · 生成时间：{html.escape(str(run.get('finished_at') or run.get('started_at') or ''))} · 质量评分：{quality_text}</p>
      <div class="toolbar">
        {markdown_button}
        <a href="/config">返回配置页</a>
      </div>
      {''.join(body_parts)}
    </main>
  </div>
</body>
</html>"""


async def scheduler_loop() -> None:
    while True:
        try:
            now = datetime.now()
            jobs = await store.list_jobs()
            for job in jobs:
                next_run_at = job.get("next_run_at")
                if not job.get("enabled") or not next_run_at:
                    continue
                try:
                    due_at = datetime.fromisoformat(next_run_at)
                except ValueError:
                    due_at = calculate_next_run_at(job.get("schedule_time", "09:00"), now - timedelta(days=1))
                if due_at <= now and job.get("id") not in _running_jobs:
                    asyncio.create_task(run_daily_intel_job(job["id"]))
        except Exception:
            logger.exception("Daily intel scheduler loop failed")
        await asyncio.sleep(60)


def start_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task is None or _scheduler_task.done():
        _scheduler_task = asyncio.create_task(scheduler_loop())


async def stop_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except asyncio.CancelledError:
            pass
        _scheduler_task = None
