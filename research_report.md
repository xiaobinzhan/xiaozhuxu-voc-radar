# 小红书舆情工具 — 开源项目调研报告

## 一、调研背景

为「省心租 VOC 雷达」项目寻找可参考的开源实现，重点调研以下方向：
- 小红书/微博等社交平台的笔记采集方案
- VOC/舆情监控看板架构
- 本地 SQLite + 前后端分离 Dashboard

---

## 二、相关开源项目分析

### 1. weibo-sentiment-monitor (chainCAI/weibo-sentiment-monitor)
- **GitHub:** https://github.com/chainCAI/weibo-sentiment-monitor
- **语言:** Python
- **架构:** CDP 协议自动采集微博 + 阿里云百炼大模型情感分析 + ECharts 可视化 + 飞书报告推送
- **技术栈:** Python + Chrome DevTools Protocol + ECharts + LLM (阿里百炼)
- **优点:**
  - CDP 方案可直接借鉴（与小红书 Chrome 扩展采集思路一致）
  - LLM 情感分析比分词规则更准确
  - 飞书报告推送模式适合内部团队
- **缺点/局限:**
  - 仅支持微博，采集逻辑需适配小红书
  - 依赖阿里百炼 API，成本高
  - 无 Chrome 扩展方案（走服务端 CDP）
- **可借鉴点:** 数据采集 → LLM 分析 → ECharts 可视化 → 报告推送的完整链路

### 2. bilibili-competitor-monitor (yizecoder/bilibili-competitor-monitor)
- **GitHub:** https://github.com/yizecoder/bilibili-competitor-monitor
- **语言:** Python
- **架构:** 本地运行的 Bilibili UP 主数据监控，数据追踪 + AI 内容分析看板
- **技术栈:** Python 后端 + 数据看板
- **优点:** 本地 SQLite 存储，架构清晰，适合内部使用
- **缺点:** 针对 B 站，无情感分析
- **可借鉴点:** 本地运行 + SQLite 存储的架构模式

### 3. media-outlet-monitor (dbozbay/media-outlet-monitor)
- **GitHub:** https://github.com/dbozbay/media-outlet-monitor
- **语言:** Python
- **架构:** RSS 源采集 → 实体提取 → 情感分析 → 关键词提取 → Dashboard + API
- **优点:** 完整的数据管道架构，REST API 设计参考
- **缺点:** 基于 RSS，不适用于小红书（小红书无公开 RSS）
- **可借鉴点:** API 设计模式、实体/关键词提取思路

### 4. ReputationMonitorApp (Someshsw1109/ReputationMonitorApp)
- **GitHub:** https://github.com/Someshsw1109/ReputationMonitorApp
- **语言:** Flask + HTML
- **架构:** Reddit API (PRAW) → TextBlob 情感分析 → Dashboard
- **优点:** 轻量级，HTML + Flask 简单部署
- **缺点:** 仅 Reddit，情感分析用 TextBlob（对中文不适用）
- **可借鉴点:** 简单的 Flask + HTML 架构

### 5. AI-Sentiment-Monitoring-Dashboard (Barmana-BRM/AI-Sentiment-Monitoring-Dashboard)
- **GitHub:** https://github.com/Barmana-BRM/AI-Sentiment-Monitoring-Dashboard
- **语言:** Python
- **架构:** ML/NLP 驱动，实时社交舆情监控，交互式 Dashboard
- **优点:** 支持负向波动检测，趋势分析
- **缺点:** 面向英文社交媒体
- **可借鉴点:** 负向波动预警逻辑、趋势分析

---

## 三、技术选型建议

### 推荐架构

```
Chrome Extension (用户登录态采集)
        ↓
FastAPI (本地后端服务)
        ↓
SQLite (data/voc.db)
        ↓
单页 HTML + ECharts (前端看板)
```

### 各层选型

| 层级 | 推荐方案 | 理由 |
|---|---|---|
| 采集器 | Chrome Extension (Manifest V3) | 复用用户登录态，不触发验证码；可参考 weibo-sentiment-monitor 的 CDP 思路但需改为扩展方案 |
| 后端 | Python FastAPI | 轻量、异步、内置 Swagger 文档；参考 media-outlet-monitor 的 API 设计 |
| 数据库 | SQLite | 零配置，适合本地工具；参考 bilibili-competitor-monitor 的架构 |
| 前端 | 单文件 HTML + ECharts | 无需构建工具，适合内部工具；风格参考 Google 内部工具 |
| 情感分析 | 关键词规则 + 可选 LLM | 基础规则（PRD 第 8.4 节）+ 可选用 LLM 增强准确率 |
| 可视化 | ECharts | 中文生态成熟，支持趋势图/饼图/条形图 |

### 改进建议（针对本项目）

1. **小红书无公开 API**，必须用 Chrome 扩展复用登录态，不要用服务端 CDP（容易触发风控）
2. **情感分析**建议分两层：先做关键词规则（快速、可解释），再可选用 LLM 做二次修正
3. **城市推断**：PRD 已定义优先级，可在 Python 层用正则匹配
4. **断点恢复**：关键词矩阵采集时记录进度到 SQLite，下次从中断继续
5. **演示数据**：首次启动时自动填充 demo 数据，真实采集后自动切换

---

## 四、项目目录结构建议

```
xiaoshu,voc-radar/
├── server.py              # FastAPI 后端
├── data/
│   └── voc.db             # SQLite 数据库
├── collector-extension/
│   ├── manifest.json
│   ├── background.js
│   └── content.js
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── demo_data.json         # 演示数据
└── README.md
```

---

*调研完成，供 OpenCode 编码阶段参考。*
