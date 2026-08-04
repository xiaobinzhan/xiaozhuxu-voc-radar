"""
省心租 VOC 雷达 - 后端服务
本地 SQLite + FastAPI, 提供所有 REST API 端点
"""
import os
import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List, Dict, Any

app = FastAPI(title="省心租 VOC 雷达 API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"
DB_PATH = DATA_DIR / "voc.db"
DEMO_DATA_PATH = DATA_DIR / "demo_notes.json"
STATIC_DIR = Path(__file__).parent

app.mount("/static", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")

# ─── 数据处理规则 (PRD §8) ─────────────────────────────────────────────────

NEGATIVE_WORDS = {
    "投诉", "避雷", "踩坑", "后悔", "失望", "维权", "甲醛", "漏水",
    "不退押金", "乱收费", "涨价", "霸王条款", "不回复", "拖延",
    "踢皮球", "不省心", "恶心", "骗", "垃圾", "差", "坑",
}

POSITIVE_WORDS = {
    "满意", "推荐", "不错", "及时", "负责", "顺利", "干净",
    "靠谱", "解决了", "体验好", "服务好", "响应快", "当天解决",
    "省事", "放心", "出租快", "托管省心", "没踩坑", "不踩雷",
    "没翻车", "好", "棒", "赞", "好评",
}

HIGH_RISK_WORDS = {
    "甲醛", "安全", "报警", "维权", "起诉", "不退押金",
    "漏水", "发霉", "蟑螂", "霸王条款", "诈骗", "黑心",
}

OFFICIAL_INDICATORS = [
    "官方", "贝壳找房", "贝壳租房", "贝壳省心租", "省心租官方",
    "链家", "客服", "小助手", "管家号", "企业号",
]

BRAND_KEYWORD = "省心租"

TENANT_KEYWORDS = {
    "租房", "入住", "退租", "押金", "室友", "管家", "房间", "租客",
    "水电", "维修", "退租", "违约金", "续租", "涨价",
}

LANDLORD_KEYWORDS = {
    "房东", "业主", "托管", "收房", "出租", "空置", "租金收益",
    "收租", "业主群",
}

SCENE_MAPPING = {
    "维修": ["维修", "坏了", "故障", "漏水", "甲醛", "空调", "热水器"],
    "管家服务": ["管家", "回复", "联系", "不回复", "拖延", "踢皮球"],
    "退租押金": ["退租", "押金", "不退押金", "违约金", "扣钱"],
    "收费问题": ["收费", "乱收费", "涨价", "服务费", "隐形收费"],
    "房屋质量": ["质量", "发霉", "蟑螂", "漏水", "装修", "甲醛"],
    "合同问题": ["合同", "霸王条款", "条款", "违约"],
    "出租效率": ["出租快", "托管省心", "空置", "租客"],
    "入住体验": ["入住", "干净", "体验", "满意", "失望"],
}


def classify_emotion(text: str) -> tuple[str, int]:
    """返回 (情绪标签, 风险等级)"""
    if not text:
        return "neutral", 1
    text_lower = text.lower()
    neg_count = sum(1 for w in NEGATIVE_WORDS if w in text)
    pos_count = sum(1 for w in POSITIVE_WORDS if w in text)
    high_risk_count = sum(1 for w in HIGH_RISK_WORDS if w in text)

    risk = 1
    if neg_count > 0:
        risk += 1
    if neg_count >= 2:
        risk += 1
    if high_risk_count > 0:
        risk += 1
    risk = min(risk, 5)

    if high_risk_count > 0 or neg_count > pos_count:
        return "negative", risk
    elif pos_count > neg_count and high_risk_count == 0:
        return "positive", risk
    return "neutral", risk


def infer_city(note: dict) -> tuple[str, str]:
    """返回 (城市, 城市来源)"""
    text = f"{note.get('title', '')} {note.get('content', '')}"
    known_cities = [
        "北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉",
        "重庆", "天津", "苏州", "西安", "长沙", "郑州", "青岛", "大连",
        "宁波", "厦门", "合肥", "福州", "无锡", "昆明", "南昌", "济南",
    ]
    for city in known_cities:
        if city in text:
            return city, "text_mention"
    ip = note.get("ip_location", "")
    if ip:
        for city in known_cities:
            if city in ip:
                return city, "author_ip"
    kw = note.get("keyword", "")
    for city in known_cities:
        if city in kw:
            return city, "search_keyword"
    return "未知", "unknown"


def classify_author(note: dict) -> str:
    """返回 租客/业主/待确认"""
    text = f"{note.get('title', '')} {note.get('content', '')} {note.get('author', '')}"
    tenant_hits = sum(1 for w in TENANT_KEYWORDS if w in text)
    landlord_hits = sum(1 for w in LANDLORD_KEYWORDS if w in text)
    if tenant_hits > landlord_hits:
        return "tenant"
    elif landlord_hits > tenant_hits:
        return "landlord"
    return "unknown"


def check_official(note: dict) -> tuple[bool, str, str]:
    """返回 (是否疑似官方, confidence, reason)"""
    author = note.get("author", "")
    text = f"{note.get('title', '')} {note.get('content', '')}"
    combined = author + " " + text
    reasons = []
    for indicator in OFFICIAL_INDICATORS:
        if indicator in combined:
            reasons.append(indicator)
    if reasons:
        return True, "high" if len(reasons) >= 2 else "medium", "作者名/文本含: " + "、".join(reasons)
    return False, "none", ""


def classify_scene(text: str, author_type: str) -> Optional[str]:
    """返回一级场景名称"""
    for scene, keywords in SCENE_MAPPING.items():
        for kw in keywords:
            if kw in text:
                return scene
    return None


def is_brand_relevant(note: dict) -> bool:
    text = f"{note.get('title', '')} {note.get('content', '')} {note.get('keyword', '')}"
    return BRAND_KEYWORD in text


# ─── 数据库 ─────────────────────────────────────────────────────────────────

def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            url TEXT,
            title TEXT,
            content TEXT,
            published_at TEXT,
            date_source TEXT DEFAULT 'unknown',
            author TEXT,
            city TEXT DEFAULT '未知',
            city_source TEXT DEFAULT 'unknown',
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            source TEXT DEFAULT 'xhs_web_session',
            keyword TEXT,
            tags TEXT DEFAULT '[]',
            ip_location TEXT,
            images TEXT DEFAULT '[]',
            detail_source TEXT DEFAULT 'search_card',
            brand_relevant INTEGER DEFAULT 1,
            emotion TEXT DEFAULT 'neutral',
            emotion_risk INTEGER DEFAULT 1,
            author_type TEXT DEFAULT 'unknown',
            scene TEXT,
            is_official_account INTEGER DEFAULT 0,
            official_confidence TEXT DEFAULT 'none',
            official_reason TEXT DEFAULT '',
            collected_at TEXT,
            last_sync_run_id INTEGER
        );

        CREATE TABLE IF NOT EXISTS sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT,
            finished_at TEXT,
            source TEXT DEFAULT 'xhs_web_session',
            trigger_name TEXT DEFAULT 'manual',
            status TEXT DEFAULT 'saving',
            visible_results INTEGER DEFAULT 0,
            unique_results INTEGER DEFAULT 0,
            inserted_count INTEGER DEFAULT 0,
            updated_count INTEGER DEFAULT 0,
            coverage_json TEXT DEFAULT '{}',
            error TEXT
        );

        CREATE TABLE IF NOT EXISTS sync_run_notes (
            run_id INTEGER,
            note_id TEXT,
            keyword TEXT,
            observed_likes INTEGER DEFAULT 0,
            observed_comments INTEGER DEFAULT 0,
            observed_at TEXT,
            FOREIGN KEY(run_id) REFERENCES sync_runs(id),
            FOREIGN KEY(note_id) REFERENCES notes(id)
        );

        CREATE TABLE IF NOT EXISTS state (
            key TEXT PRIMARY KEY,
            value TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_notes_brand ON notes(brand_relevant);
        CREATE INDEX IF NOT EXISTS idx_notes_emotion ON notes(emotion);
        CREATE INDEX IF NOT EXISTS idx_notes_published ON notes(published_at);
        CREATE INDEX IF NOT EXISTS idx_notes_city ON notes(city);
        CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON sync_runs(status);
    """)
    conn.commit()
    conn.close()


def upsert_note(note: dict, run_id: Optional[int] = None, conn: Optional[sqlite3.Connection] = None) -> tuple[str, str]:
    """返回 (action: 'inserted'/'updated', note_id)"""
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    note_id = note.get("id", f"temp_{int(time.time())}_{hash(note.get('title','')) % 10000}")
    emotion, risk = classify_emotion(note.get("title", "") + " " + note.get("content", ""))
    city, city_source = infer_city(note)
    author_type = classify_author(note)
    is_official, conf, reason = check_official(note)
    scene = classify_scene(
        note.get("title", "") + " " + note.get("content", ""),
        author_type
    )

    existing = conn.execute("SELECT id FROM notes WHERE id = ?", (note_id,)).fetchone()

    now = datetime.utcnow().isoformat() + "Z"
    if existing:
        conn.execute("""
            UPDATE notes SET
                title=?, content=?, published_at=?, date_source=?,
                author=?, city=?, city_source=?, likes=?, comments=?,
                keyword=?, tags=?, ip_location=?, images=?,
                detail_source=?, emotion=?, emotion_risk=?,
                author_type=?, scene=?, is_official_account=?,
                official_confidence=?, official_reason=?,
                collected_at=?, last_sync_run_id=?
            WHERE id=?
        """, (
            note.get("title", ""), note.get("content", ""),
            note.get("published_at"), note.get("date_source", "unknown"),
            note.get("author", ""), city, city_source,
            note.get("likes", 0), note.get("comments", 0),
            note.get("keyword", ""), json.dumps(note.get("tags", []), ensure_ascii=False),
            note.get("ip_location", ""), json.dumps(note.get("images", []), ensure_ascii=False),
            note.get("detail_source", "search_card"),
            emotion, risk, author_type, scene,
            1 if is_official else 0, conf, reason,
            now, run_id,
            note_id,
        ))
        action = "updated"
    else:
        conn.execute("""
            INSERT INTO notes
                (id, url, title, content, published_at, date_source,
                 author, city, city_source, likes, comments, source,
                 keyword, tags, ip_location, images, detail_source,
                 brand_relevant, emotion, emotion_risk, author_type,
                 scene, is_official_account, official_confidence,
                 official_reason, collected_at, last_sync_run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            note_id, note.get("url"), note.get("title", ""),
            note.get("content", ""), note.get("published_at"),
            note.get("date_source", "unknown"),
            note.get("author", ""), city, city_source,
            note.get("likes", 0), note.get("comments", 0),
            note.get("source", "xhs_web_session"),
            note.get("keyword", ""),
            json.dumps(note.get("tags", []), ensure_ascii=False),
            note.get("ip_location", ""),
            json.dumps(note.get("images", []), ensure_ascii=False),
            note.get("detail_source", "search_card"),
            1 if is_brand_relevant(note) else 0,
            emotion, risk, author_type, scene,
            1 if is_official else 0, conf, reason,
            now, run_id,
        ))
        action = "inserted"

    conn.commit()
    if own_conn:
        conn.close()
    return action, note_id


# ─── 同步状态管理 ─────────────────────────────────────────────────────────────

class SyncState:
    def __init__(self):
        self._lock = threading.Lock()
        self._data: Dict[str, Any] = {
            "source_mode": "demo",
            "collector_status": "disconnected",
            "last_sync": None,
            "next_run": None,
            "sync_stage": "idle",
            "sync_progress": 0,
            "current_keyword": "",
            "current_keyword_index": 0,
            "keyword_total": 0,
            "last_coverage": {},
            "last_error": "",
            "sync_requested": 0,
            "resume_keyword": "",
            "resume_keyword_index": 0,
            "collector_version": "1.0.0",
        }
        self._load()

    def _load(self):
        if not DB_PATH.exists():
            return
        try:
            conn = get_conn()
            rows = conn.execute("SELECT key, value FROM state").fetchall()
            conn.close()
            for row in rows:
                try:
                    self._data[row["key"]] = json.loads(row["value"])
                except Exception:
                    self._data[row["key"]] = row["value"]
        except Exception:
            pass  # table may not exist yet

    def _save(self):
        conn = get_conn()
        for k, v in self._data.items():
            conn.execute(
                "INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)",
                (k, json.dumps(v, ensure_ascii=False))
            )
        conn.commit()
        conn.close()

    def get(self, key: str, default=None):
        with self._lock:
            return self._data.get(key, default)

    def set(self, key: str, value):
        with self._lock:
            self._data[key] = value
            self._save()

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._data)


sync_state = SyncState()


# ─── 端点 ─────────────────────────────────────────────────────────────────────

@app.get("/")
@app.get("/index.html")
async def serve_index():
    return FileResponse(str(STATIC_DIR / "index.html"))

@app.on_event("startup")
def startup():
    init_db()
    # 如果没有数据，加载 demo
    conn = get_conn()
    count = conn.execute("SELECT COUNT(*) as cnt FROM notes").fetchone()["cnt"]
    conn.close()
    if count == 0:
        load_demo_data()
        sync_state.set("source_mode", "demo")


@app.get("/api/notes")
def get_notes(
    emotion: Optional[str] = Query(None),
    author_type: Optional[str] = Query(None),
    scene: Optional[str] = Query(None),
    city: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    limit: int = Query(100, le=500),
    offset: int = Query(0),
):
    """返回品牌相关笔记，支持筛选"""
    conn = get_conn()
    conditions = ["brand_relevant = 1"]
    params: list = []

    if emotion:
        conditions.append("emotion = ?")
        params.append(emotion)
    if author_type:
        conditions.append("author_type = ?")
        params.append(author_type)
    if scene:
        conditions.append("scene = ?")
        params.append(scene)
    if city:
        conditions.append("city = ?")
        params.append(city)
    if keyword:
        conditions.append("(title LIKE ? OR content LIKE ? OR author LIKE ?)")
        Like = f"%{keyword}%"
        params.extend([Like, Like, Like])
    if date_from:
        conditions.append("published_at >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("published_at <= ?")
        params.append(date_to)

    where = " AND ".join(conditions) if conditions else "1=1"
    total = conn.execute(f"SELECT COUNT(*) as cnt FROM notes WHERE {where} AND brand_relevant=1", params).fetchone()["cnt"]
    rows = conn.execute(
        f"SELECT * FROM notes WHERE {where} AND brand_relevant=1 ORDER BY published_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset]
    ).fetchall()
    conn.close()

    notes = [dict(r) for r in rows]
    # 反序列化 JSON 字段
    for n in notes:
        for field in ("tags", "images"):
            if n.get(field) and isinstance(n[field], str):
                try:
                    n[field] = json.loads(n[field])
                except Exception:
                    pass
    return {"notes": notes, "total": total, "limit": limit, "offset": offset,
            "source_mode": sync_state.get("source_mode", "demo")}


@app.get("/api/notes/stats")
def get_notes_stats():
    """返回统计概览数据，供监控总览页使用"""
    conn = get_conn()
    today = datetime.utcnow().date()
    thirty_ago = (today - timedelta(days=29)).isoformat()
    sixty_ago = (today - timedelta(days=59)).isoformat()

    # 近30天统计
    recent_total = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND published_at >= ?",
        (thirty_ago,)
    ).fetchone()["cnt"]
    recent_negative = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion='negative' AND published_at >= ?",
        (thirty_ago,)
    ).fetchone()["cnt"]
    recent_positive = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion='positive' AND published_at >= ?",
        (thirty_ago,)
    ).fetchone()["cnt"]
    recent_neutral = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion='neutral' AND published_at >= ?",
        (thirty_ago,)
    ).fetchone()["cnt"]

    # 上周期 (30-60天前)
    prev_negative = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion='negative' AND published_at >= ? AND published_at < ?",
        (sixty_ago, thirty_ago)
    ).fetchone()["cnt"]
    prev_positive = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion='positive' AND published_at >= ? AND published_at < ?",
        (sixty_ago, thirty_ago)
    ).fetchone()["cnt"]

    # 高风险
    high_risk = conn.execute(
        "SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND emotion_risk >= 4 AND published_at >= ?",
        (thirty_ago,)
    ).fetchone()["cnt"]

    # 独立发声用户
    unique_authors = conn.execute(
        "SELECT COUNT(DISTINCT author) as cnt FROM notes WHERE brand_relevant=1 AND emotion='negative' AND published_at >= ? AND author != '' AND author IS NOT NULL",
        (thirty_ago,)
    ).fetchone()["cnt"]

    # 城市分布
    city_stats = conn.execute(
        "SELECT city, COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND published_at >= ? GROUP BY city ORDER BY cnt DESC LIMIT 15",
        (thirty_ago,)
    ).fetchall()

    # 场景排行
    scene_stats = conn.execute(
        "SELECT scene, emotion, COUNT(*) as cnt FROM notes WHERE brand_relevant=1 AND scene IS NOT NULL AND scene != '' AND published_at >= ? GROUP BY scene, emotion ORDER BY cnt DESC LIMIT 20",
        (thirty_ago,)
    ).fetchall()

    # 趋势（按周）
    trend = conn.execute("""
        SELECT
            CASE
                WHEN published_at >= date('now', '-7 days') THEN '近1周'
                WHEN published_at >= date('now', '-14 days') THEN '近2周'
                WHEN published_at >= date('now', '-21 days') THEN '近3周'
                WHEN published_at >= date('now', '-28 days') THEN '近4周'
                WHEN published_at >= date('now', '-35 days') THEN '近5周'
                WHEN published_at >= date('now', '-42 days') THEN '近6周'
                ELSE '更早'
            END as week_label,
            emotion, COUNT(*) as cnt
        FROM notes
        WHERE brand_relevant=1 AND published_at >= date('now', '-42 days')
        GROUP BY week_label, emotion
        ORDER BY week_label
    """).fetchall()

    # 关键词覆盖统计
    keyword_stats = conn.execute(
        "SELECT keyword, COUNT(DISTINCT id) as cnt FROM notes WHERE brand_relevant=1 GROUP BY keyword ORDER BY cnt DESC"
    ).fetchall()

    # 格式化趋势数据
    trend_map: Dict[str, Dict[str, int]] = {}
    for row in trend:
        week = row["week_label"]
        emo = row["emotion"] or "neutral"
        if week not in trend_map:
            trend_map[week] = {"negative": 0, "positive": 0, "neutral": 0}
        trend_map[week][emo] = row["cnt"]

    trend_list = []
    for week in sorted(trend_map.keys()):
        d = trend_map[week]
        trend_list.append({
            "label": week,
            "negative": d.get("negative", 0),
            "positive": d.get("positive", 0),
            "neutral": d.get("neutral", 0),
            "total": sum(d.values()),
        })

    # 场景排行
    scene_rank = {}
    for row in scene_stats:
        s = row["scene"]
        if s not in scene_rank:
            scene_rank[s] = {"total": 0, "negative": 0, "positive": 0, "neutral": 0}
        scene_rank[s]["total"] += row["cnt"]
        emo = row["emotion"] or "neutral"
        if emo in scene_rank[s]:
            scene_rank[s][emo] += row["cnt"]

    scene_list = sorted(scene_rank.items(), key=lambda x: x[1]["total"], reverse=True)[:10]

    # 城市列表
    city_list = [{"city": r["city"], "count": r["cnt"]} for r in city_stats]

    # 最新高风险笔记
    high_risk_notes = conn.execute(
        "SELECT id, title, published_at, city, emotion_risk, likes, comments, scene, author "
        "FROM notes WHERE brand_relevant=1 AND emotion_risk >= 4 AND published_at >= ? "
        "ORDER BY published_at DESC LIMIT 10",
        (thirty_ago,)
    ).fetchall()

    # 负面占比
    negative_ratio = round(recent_negative / recent_total * 100, 1) if recent_total > 0 else 0

    # 变化率
    neg_change = round(
        (recent_negative - prev_negative) / prev_negative * 100, 1
    ) if prev_negative > 0 else (0 if recent_negative == 0 else 100)
    pos_change = round(
        (recent_positive - prev_positive) / prev_positive * 100, 1
    ) if prev_positive > 0 else (0 if recent_positive == 0 else 100)

    conn.close()

    return {
        "recent_total": recent_total,
        "recent_negative": recent_negative,
        "recent_positive": recent_positive,
        "recent_neutral": recent_neutral,
        "negative_ratio": negative_ratio,
        "high_risk_count": high_risk,
        "unique_negative_authors": unique_authors,
        "negative_change": neg_change,
        "positive_change": pos_change,
        "trend": trend_list,
        "scene_rank": [{"name": k, **v} for k, v in scene_list],
        "city_distribution": city_list,
        "high_risk_notes": [dict(r) for r in high_risk_notes],
        "keyword_stats": [{"keyword": r["keyword"], "count": r["cnt"]} for r in keyword_stats],
    }


@app.get("/api/status")
def get_status():
    state = sync_state.snapshot()
    conn = get_conn()
    total_notes = conn.execute("SELECT COUNT(*) as cnt FROM notes WHERE brand_relevant=1").fetchone()["cnt"]
    last_sync_row = conn.execute(
        "SELECT started_at, status FROM sync_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    conn.close()

    return {
        "source_mode": state.get("source_mode", "demo"),
        "collector_status": state.get("collector_status", "disconnected"),
        "last_sync": last_sync_row["started_at"] if last_sync_row else state.get("last_sync"),
        "next_run": state.get("next_run"),
        "sync_stage": state.get("sync_stage", "idle"),
        "sync_progress": state.get("sync_progress", 0),
        "current_keyword": state.get("current_keyword", ""),
        "current_keyword_index": state.get("current_keyword_index", 0),
        "keyword_total": state.get("keyword_total", 0),
        "last_error": state.get("last_error", ""),
        "total_notes": total_notes,
        "coverage": state.get("last_coverage", {}),
    }


@app.post("/api/request-sync")
def request_sync():
    sync_state.set("sync_requested", 1)
    sync_state.set("sync_stage", "queued")
    sync_state.set("last_error", "")
    now = datetime.utcnow().isoformat() + "Z"
    sync_state.set("last_sync", now)
    return {"ok": True, "message": "同步任务已加入队列"}


@app.get("/api/jobs/pending")
def pending_jobs():
    """扩展轮询：返回待处理任务"""
    state = sync_state.snapshot()
    jobs = []

    if state.get("sync_requested", 0):
        jobs.append({
            "type": "sync",
            "resume_keyword": state.get("resume_keyword", ""),
            "resume_keyword_index": state.get("resume_keyword_index", 0),
        })

    return {"jobs": jobs, "state": state}


@app.post("/api/collector-status")
def collector_status(body: Dict[str, Any]):
    for key in ["collector_status", "sync_stage", "sync_progress",
                "current_keyword", "current_keyword_index", "keyword_total",
                "last_error", "next_run", "collector_version"]:
        if key in body:
            sync_state.set(key, body[key])
    return {"ok": True}


@app.post("/api/ingest")
def ingest_notes(body: Dict[str, Any]):
    source = body.get("source", "xhs_web_session")
    trigger = body.get("trigger", "manual")
    started_at = body.get("started_at", datetime.utcnow().isoformat() + "Z")
    coverage = body.get("coverage", {})
    raw_notes = body.get("notes", [])

    # 开启同步批次
    conn = get_conn()
    cursor = conn.execute(
        "INSERT INTO sync_runs (started_at, source, trigger_name, status) VALUES (?, ?, ?, ?)",
        (started_at, source, trigger, "saving")
    )
    run_id = cursor.lastrowid

    inserted = 0
    updated = 0
    rejected = 0
    visible = len(raw_notes)

    for note in raw_notes:
        relevant = is_brand_relevant(note)
        action, note_id = upsert_note(note, run_id, conn)
        if action == "inserted":
            inserted += 1
        else:
            updated += 1
        if not relevant:
            rejected += 1
        # 记录观察
        conn.execute(
            "INSERT INTO sync_run_notes (run_id, note_id, keyword, observed_likes, observed_comments, observed_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, note_id, note.get("keyword", ""),
             note.get("likes", 0), note.get("comments", 0),
             datetime.utcnow().isoformat() + "Z")
        )

    unique = conn.execute(
        "SELECT COUNT(DISTINCT id) as cnt FROM notes WHERE last_sync_run_id = ?", (run_id,)
    ).fetchone()["cnt"]

    conn.execute(
        "UPDATE sync_runs SET finished_at=?, status=?, visible_results=?, unique_results=?, "
        "inserted_count=?, updated_count=?, coverage_json=? WHERE id=?",
        (datetime.utcnow().isoformat() + "Z", "completed", visible, unique,
         inserted, updated, json.dumps(coverage, ensure_ascii=False), run_id)
    )
    conn.commit()
    conn.close()

    sync_state.set("sync_requested", 0)
    sync_state.set("sync_stage", "idle")
    sync_state.set("sync_progress", 100)
    sync_state.set("last_coverage", coverage)
    sync_state.set("last_sync", started_at)
    sync_state.set("source_mode", "xhs_web_session")

    return {
        "ok": True,
        "inserted": inserted,
        "updated": updated,
        "rejected_irrelevant": rejected,
        "total": visible,
        "run_id": run_id,
    }


@app.post("/api/open-note")
def open_note(body: Dict[str, Any]):
    """按标题搜索原文，优先打开本地 Chrome"""
    title = body.get("title", "")
    note_id = body.get("id", "")
    import subprocess
    import sys
    # 尝试通过本地服务打开（由 collector 处理）
    # 写入 pending job
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO state (key, value) VALUES ('pending_open_note', ?)",
        (json.dumps({"id": note_id, "title": title, "opened_at": datetime.utcnow().isoformat()}),)
    )
    conn.commit()
    conn.close()
    # 尝试用默认浏览器打开小红书搜索
    try:
        import webbrowser
        search_url = f"https://www.xiaohongshu.com/search_result?keyword={title}"
        webbrowser.open(search_url)
        return {"ok": True, "action": "browser_opened", "url": search_url}
    except Exception as e:
        return {"ok": False, "error": str(e), "note_id": note_id}


@app.get("/api/sync-runs")
def get_sync_runs(limit: int = Query(30, le=100)):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return {"runs": [dict(r) for r in rows]}


@app.get("/api/export/csv")
def export_csv(
    emotion: Optional[str] = Query(None),
    author_type: Optional[str] = Query(None),
    scene: Optional[str] = Query(None),
    city: Optional[str] = Query(None),
):
    """导出 CSV"""
    import csv, io
    conn = get_conn()
    conditions = ["brand_relevant = 1"]
    params = []
    if emotion:
        conditions.append("emotion = ?"); params.append(emotion)
    if author_type:
        conditions.append("author_type = ?"); params.append(author_type)
    if scene:
        conditions.append("scene = ?"); params.append(scene)
    if city:
        conditions.append("city = ?"); params.append(city)
    where = " AND ".join(conditions) if conditions else "1=1"
    rows = conn.execute(f"SELECT * FROM notes WHERE {where} ORDER BY published_at DESC", params).fetchall()
    conn.close()

    output = io.StringIO()
    fieldnames = ["published_at", "title", "content", "author", "city", "city_source",
                   "emotion", "emotion_risk", "author_type", "scene",
                   "likes", "comments", "keyword", "tags", "images",
                   "detail_source", "is_official_account", "official_reason", "url", "collected_at"]
    writer = csv.DictWriter(output, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        d = dict(row)
        for f in ("tags", "images"):
            if isinstance(d.get(f), list):
                d[f] = "; ".join(d[f])
        writer.writerow(d)
    return output.getvalue()


# ─── Demo 数据加载 ───────────────────────────────────────────────────────────

def load_demo_data():
    """加载演示数据到数据库"""
    import random
    cities = ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "未知"]
    authors = ["小明爱租房", "安心住管家", "租房避坑指南", "上海租房日记",
               "省心租体验官", "杭州租房求助", "贝壳省心租", "租客小李", "业主老张"]
    titles = [
        "省心租体验分享｜北京朝阳区入住一个月",
        "省心租踩坑了！甲醛超标怎么办",
        "北京省心租退租押金被扣，太失望了",
        "省心租管家服务太棒了，响应超快",
        "上海省心租避雷｜中介乱收费",
        "省心租真的靠谱吗？上海入住半年感受",
        "省心租维修问题拖了两周没解决",
        "省心租出租快｜业主托管体验",
        "广州省心租｜管家不负责踢皮球",
        "省心租甲醛问题，入住就咳嗽",
        "省心租退租违约金太高，霸王条款",
        "省心租推荐！管家很负责，入住顺利",
        "深圳省心租踩坑｜水电费乱收费",
        "省心租托管省心｜空置期管理",
        "杭州省心租｜房东反馈很差，不退押金",
        "省心租维修及时，体验不错",
        "省心租涨价了，续租费用高",
        "省心租投诉无门，维权太难",
        "省心租靠谱｜管家每天问候",
        "省心租漏水问题，物业不处理",
    ]
    contents = [
        "省心租管家服务不错，入住很快就安排好了，房间很干净。",
        "真心避雷省心租！住进去才发现甲醛超标，联系管家一直不回复，太让人失望了。",
        "省心租退租的时候押金被扣了3000，说是墙面有污渍，完全是霸王条款。",
        "省心租的管家很负责，有什么问题都能及时响应，体验很好，推荐！",
        "上海省心租踩坑了，合同里藏着很多隐形收费，入住后才发现。",
        "住省心租半年了，总体来说还行，就是管家有时候联系不上。",
        "省心租维修真的慢，热水坏了两周了还没人来修，体验很差。",
        "省心租出租快是真的，托管省心，房东再也不用操心租房子的事了。",
        "广州省心租体验糟糕，管家对投诉置之不理，纯属踢皮球。",
        "新租了省心租，入住第二天就开始咳嗽，怀疑甲醛超标。",
        "省心租退租违约金太高了，合同里写的清清楚楚，感觉是霸王条款。",
        "省心租推荐！管家服务态度很好，入住流程顺畅，没踩坑。",
        "深圳省心租踩坑，水电费比市场价高出一大截，乱收费。",
        "省心租托管省心，房子空置期不用自己操心，出租也快。",
        "杭州省心租体验很差，押金不退，管家一直拖，打算维权。",
        "省心租维修响应很快，当天就解决了，体验不错。",
        "省心租续租涨价了，比之前贵了15%，感觉不太合理。",
        "省心租投诉了三次没人管，决定维权起诉，太失望了。",
        "省心租管家每天问候，服务态度很好，体验超出了预期。",
        "省心租房子漏水，联系了物业和管家都不处理，甲醛问题也没人管。",
    ]
    keywords = [
        "省心租", "省心租 体验", "省心租 踩坑", "省心租 避雷",
        "省心租 投诉", "省心租 维修", "省心租 押金",
        "北京 省心租", "上海 省心租", "广州 省心租", "深圳 省心租",
        "杭州 省心租", "省心租 管家", "省心租 甲醛",
    ]
    scenes = ["维修", "管家服务", "退租押金", "收费问题", "房屋质量", "合同问题", "出租效率", "入住体验"]

    now = datetime.utcnow()
    notes = []
    for i in range(80):
        days_ago = random.randint(0, 60)
        pub_date = (now - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        title = random.choice(titles)
        content = random.choice(contents)
        city = random.choice(cities)
        source_type = random.choice(["text_mention", "author_ip", "search_keyword", "unknown"])
        if source_type == "search_keyword" and city != "未知":
            kw = f"{city} 省心租"
        elif source_type == "author_ip":
            kw = random.choice(keywords)
        else:
            kw = random.choice(keywords)

        emotion, risk = classify_emotion(title + " " + content)
        author_type = classify_author({"title": title, "content": content, "author": random.choice(authors)})
        is_official, _, _ = check_official({"title": title, "content": content, "author": random.choice(authors)})
        scene = random.choice(scenes) if random.random() > 0.1 else None
        likes = random.randint(5, 500)
        comments = random.randint(0, 100)

        notes.append({
            "id": f"demo_{i:04d}",
            "url": f"https://www.xiaohongshu.com/explore/{i:08x}",
            "title": title,
            "content": content,
            "published_at": pub_date,
            "date_source": "exact_date",
            "author": random.choice(authors),
            "city": city,
            "city_source": source_type,
            "likes": likes,
            "comments": comments,
            "source": "xhs_web_session",
            "keyword": kw,
            "tags": ["租房", "省心租"],
            "ip_location": f"{city}IP属地" if city != "未知" else "",
            "images": [f"https://example.com/img{i}.jpg"] if random.random() > 0.5 else [],
            "detail_source": "search_card" if random.random() > 0.3 else "detail_page",
            "brand_relevant": 1,
            "emotion": emotion,
            "emotion_risk": risk,
            "author_type": author_type,
            "scene": scene,
            "is_official_account": 1 if is_official else 0,
            "official_confidence": "high" if is_official else "none",
            "official_reason": "作者名含'贝壳'或'省心租官方'" if is_official else "",
            "collected_at": now.isoformat() + "Z",
        })

    # 保存到 demo 文件
    DEMO_DATA_PATH.parent.mkdir(exist_ok=True)
    with open(DEMO_DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)

    # 写入数据库
    for note in notes:
        upsert_note(note)
    print(f"Loaded {len(notes)} demo notes")


# ─── 主入口 ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="省心租 VOC 雷达后端服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--share", action="store_true", help="启用局域网分享模式（只读）")
    args = parser.parse_args()

    host = "0.0.0.0" if args.share else "127.0.0.1"
    print(f"Starting server on {host}:{args.port}")
    if args.share:
        print("⚠️  SHARE MODE: 局域网访问为只读，无法同步/导入")
    import uvicorn
    uvicorn.run(app, host=host, port=args.port, log_level="info")
