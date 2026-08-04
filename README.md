# 省心租 VOC 雷达

面向内部业务团队的「小红书省心租客户声音监控与证据分析工具」。

自动采集和分析小红书上与贝壳省心租相关的公开笔记，持续监控负面/正向评价、城市分布、租客/业主不满意场景、声量趋势、证据原文和采集完整性。

---

## 目录结构

```
省心租VOC雷达/
├── server.py              # Python FastAPI 后端服务
├── index.html             # 前端监控总览 + 笔记库 + 场景 + 任务页
├── styles.css             # 前端样式（Google 内部工具风格）
├── app.js                 # 前端逻辑 + ECharts 图表
├── collector-extension/   # Chrome 扩展（数据采集器）
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── popup.html
├── data/                  # 本地数据库
│   └── voc.db             # SQLite（首次启动自动生成）
├── PRD_省心租VOC雷达.md   # 产品需求文档
└── README.md              # 本文件
```

---

## 安装依赖

```bash
# Python 3.11+
pip install fastapi uvicorn pydantic

# 无需 Node.js / 前端构建工具
# ECharts 通过 CDN 加载
```

---

## 启动服务

### 本地模式（仅本机访问）

```bash
python server.py
```

服务启动在 `http://127.0.0.1:8000`，浏览器打开：
```
http://127.0.0.1:8000
```

### 同 Wi-Fi 分享模式（局域网只读）

```bash
python server.py --share
```

服务启动在 `http://0.0.0.0:8000`，局域网内其他设备可通过本机 IP 只读访问（不能同步、导入或打开原文）。

> 首次启动会自动加载 80 条演示数据，明确标识为「演示数据」，不影响功能验证。

---

## 安装 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目中的 `collector-extension/` 目录
5. 在 Chrome 中登录 [xiaohongshu.com](https://www.xiaohongshu.com)
6. 回到看板，点击「立即同步」开始采集

---

## 首次同步

1. 确保已在 Chrome 登录小红书网页版
2. 扩展已正确加载（工具栏出现扩展图标）
3. 点击看板右上角「立即同步」
4. 左侧导航 →「搜索任务」查看采集进度
5. 同步完成后，监控总览自动刷新

---

## 数据规则说明

- **品牌相关**：标题/正文/标签必须包含「省心租」
- **近 30 天**：以笔记发布时间为准，不以采集时间代替
- **城市来源**：正文提及 > 作者 IP > 城市搜索词 > 未知
- **正向评价**：需有正向关键词采集入口，不从负面搜索中识别
- **疑似官方账号**：作者名含「官方」「贝壳找房」等关键词，标注为「疑似」

---

## 合规声明

- 使用本人网页登录态读取小红书网页端正常可见的公开搜索结果
- 低频运行，每关键词默认滚动 6 次，不提高频率规避限制
- 遇到验证码/访问限制/登录失效立即停止，不绕过平台机制
- 结果不代表小红书全站数据，仅供内部参考
- 正式生产建议采购有明确授权的数据 API

---

## API 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/notes` | GET | 笔记列表（支持筛选） |
| `/api/notes/stats` | GET | 统计概览数据 |
| `/api/notes/export/csv` | GET | 导出 CSV |
| `/api/status` | GET | 同步状态 |
| `/api/request-sync` | POST | 触发同步 |
| `/api/jobs/pending` | GET | 扩展轮询任务 |
| `/api/collector-status` | POST | 扩展上报状态 |
| `/api/ingest` | POST | 扩展提交采集结果 |
| `/api/open-note` | POST | 按标题打开原文 |
| `/api/sync-runs` | GET | 同步历史记录 |

---

## 技术栈

- **后端**：Python 3.11 + FastAPI + SQLite
- **前端**：原生 HTML/CSS/JS，ECharts 5（CDN）
- **采集器**：Chrome Extension Manifest V3
