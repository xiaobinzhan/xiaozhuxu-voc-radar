/**
 * 省心租 VOC 雷达 - 前端主逻辑
 * 对接 /api/* 端点，支持 demo 数据回退
 */

const API = '/api';
const KEYWORDS = [
  '省心租', '贝壳省心租', '贝壳租房',
  '省心租 体验', '省心租 好住', '省心租 推荐', '省心租 靠谱',
  '省心租 服务好', '省心租 管家负责', '省心租 维修及时',
  '省心租 出租快', '省心租 托管省心', '贝壳省心租 怎么样',
  '省心租 避雷', '省心租 踩坑', '省心租 投诉', '省心租 维权',
  '省心租 后悔',
  '省心租 维修', '省心租 管家', '省心租 甲醛', '省心租 水电',
  '省心租 服务费',
  '省心租 退租', '省心租 押金', '省心租 违约金', '省心租 涨价',
  '省心租 续租',
  '北京 省心租', '上海 省心租', '广州 省心租', '深圳 省心租',
  '杭州 省心租', '成都 省心租', '南京 省心租', '武汉 省心租',
];

const SCENES = ['维修', '管家服务', '退租押金', '收费问题', '房屋质量', '合同问题', '出租效率', '入住体验'];

let currentNotes = [];
let allNotes = [];
let chartInstances = {};
let filterState = { emotion: '', authorType: '', scene: '', city: '', keyword: '', dateFrom: '', dateTo: '' };
let noteOffset = 0;
const NOTE_LIMIT = 20;
let isSyncing = false;

// ─── 页面导航 ────────────────────────────────────────────────────────────────

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    navigateTo(page);
  });
});

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.getElementById(`page-${page}`)?.classList.add('active');
  const titles = { overview: '监控总览', notes: '笔记库', scenes: '投诉场景', tasks: '搜索任务' };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  if (page === 'overview') loadOverview();
  else if (page === 'notes') loadNotes();
  else if (page === 'scenes') loadScenes();
  else if (page === 'tasks') loadTasks();
}

// ─── API 调用 ────────────────────────────────────────────────────────────────

async function apiGet(path) {
  try {
    const resp = await fetch(API + path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (e) {
    console.warn('API GET failed:', e);
    return null;
  }
}

async function apiPost(path, body) {
  try {
    const resp = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await resp.json();
  } catch (e) {
    console.warn('API POST failed:', e);
    return null;
  }
}

// ─── 监控总览 ────────────────────────────────────────────────────────────────

async function loadOverview() {
  showLoading('overview');
  const stats = await apiGet('/api/notes/stats');
  if (!stats) { showDemoFallback('overview'); return; }

  // 指标卡
  document.getElementById('mNegative').textContent = stats.recent_negative ?? '--';
  const negCh = stats.negative_change;
  const negEl = document.getElementById('mNegativeChange');
  if (negCh !== null && negCh !== undefined) {
    negEl.textContent = `${negCh > 0 ? '↑' : negCh < 0 ? '↓' : '—'} ${Math.abs(negCh)}% vs 上周期`;
    negEl.className = 'metric-change ' + (negCh > 0 ? 'up' : 'down');
  }
  document.getElementById('mRatio').textContent = (stats.negative_ratio ?? '--') + '%';
  document.getElementById('mPositive').textContent = stats.recent_positive ?? '--';
  const posCh = stats.positive_change;
  const posEl = document.getElementById('mPositiveChange');
  if (posCh !== null && posCh !== undefined) {
    posEl.textContent = `${posCh > 0 ? '↑' : posCh < 0 ? '↓' : '—'} ${Math.abs(posCh)}% vs 上周期`;
    posEl.className = 'metric-change ' + (posCh < 0 ? 'up' : 'down');
  }
  document.getElementById('mHighRisk').textContent = stats.high_risk_count ?? '--';
  document.getElementById('mUniqueAuthors').textContent = stats.unique_negative_authors ?? '--';

  // 趋势图
  renderTrendChart(stats.trend || []);

  // 场景排行
  renderSceneChart(stats.scene_rank || []);

  // 城市分布
  renderCityChart(stats.city_distribution || []);

  // 高风险表格
  renderHighRiskTable(stats.high_risk_notes || []);

  // 异常预警
  renderAlerts(stats);

  // 覆盖报告
  renderCoverage(stats);

  // 检查 demo 模式
  checkSourceMode();
}

function renderTrendChart(data) {
  const dom = document.getElementById('trendChart');
  if (!dom) return;
  if (chartInstances.trend) { chartInstances.trend.dispose(); delete chartInstances.trend; }
  chartInstances.trend = echarts.init(dom);
  const weeks = data.map(d => d.label);
  chartInstances.trend.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: ['负面', '正向', '中性'], bottom: 0, fontSize: 11 },
    grid: { top: 10, right: 16, bottom: 36, left: 40 },
    xAxis: { type: 'category', data: weeks, axisLabel: { fontSize: 11 } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    series: [
      { name: '负面', type: 'line', data: data.map(d => d.negative || 0), smooth: true,
        lineStyle: { color: '#c5221f' }, itemStyle: { color: '#c5221f' }, areaStyle: { color: 'rgba(197,34,31,0.08)' } },
      { name: '正向', type: 'line', data: data.map(d => d.positive || 0), smooth: true,
        lineStyle: { color: '#137333' }, itemStyle: { color: '#137333' }, areaStyle: { color: 'rgba(19,115,51,0.08)' } },
      { name: '中性', type: 'line', data: data.map(d => d.neutral || 0), smooth: true,
        lineStyle: { color: '#5f6368' }, itemStyle: { color: '#5f6368' }, areaStyle: { color: 'rgba(95,99,104,0.06)' } },
    ],
    visualMap: { show: false, pieces: [{ gt: 0, color: '#5f6368' }] },
  });
  // 洞察文字
  const insight = document.getElementById('trendInsight');
  if (data.length > 0) {
    const last = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : last;
    const negDiff = last.negative - (prev.negative || 0);
    const posDiff = last.positive - (prev.positive || 0);
    let html = '';
    if (negDiff > 0) html += `最近一周负面笔记上升 ${negDiff} 篇。`;
    else if (negDiff < 0) html += `最近一周负面笔记下降 ${Math.abs(negDiff)} 篇。`;
    if (posDiff > 0) html += `正向上升 ${posDiff} 篇。`;
    else if (posDiff < 0) html += `正向下降 ${Math.abs(posDiff)} 篇。`;
    html += ' 注意：官方账号可能影响正向口径。';
    insight.textContent = html;
  }
}

function renderSceneChart(data) {
  const dom = document.getElementById('sceneRankChart');
  if (!dom) return;
  if (chartInstances.scene) { chartInstances.scene.dispose(); delete chartInstances.scene; }
  chartInstances.scene = echarts.init(dom);
  const sorted = data.slice(0, 8).reverse();
  chartInstances.scene.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { top: 8, right: 16, bottom: 8, left: 90 },
    xAxis: { type: 'value', axisLabel: { fontSize: 11 } },
    yAxis: { type: 'category', data: sorted.map(d => d.name), axisLabel: { fontSize: 11 } },
    series: [{
      type: 'bar',
      data: sorted.map(d => d.total),
      itemStyle: { color: '#1a73e8', borderRadius: [0, 4, 4, 0] },
      barWidth: 14,
    }],
  });
  sorted.forEach((s, i) => {
    dom.addEventListener('click', () => {
      filterState.scene = s.name;
      navigateTo('notes');
      applyFilters();
    });
  });
}

function renderCityChart(data) {
  const dom = document.getElementById('cityChart');
  if (!dom) return;
  if (chartInstances.city) { chartInstances.city.dispose(); delete chartInstances.city; }
  chartInstances.city = echarts.init(dom);
  chartInstances.city.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, fontSize: 11, type: 'scroll' },
    series: [{
      type: 'pie',
      radius: ['40%', '68%'],
      center: ['50%', '42%'],
      data: data.map(d => ({ name: d.city, value: d.count })),
      label: { fontSize: 11, formatter: '{b}\n{c}' },
      itemStyle: { borderRadius: 6 },
    }],
  });
}

function renderHighRiskTable(notes) {
  const tbody = document.getElementById('highRiskTable');
  if (!tbody) return;
  if (!notes.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#80868b;padding:20px">暂无高风险笔记</td></tr>'; return; }
  tbody.innerHTML = notes.map(n => `
    <tr onclick="showNoteDetail('${n.id}')" style="cursor:pointer">
      <td>${n.published_at || '--'}</td>
      <td>${escHtml(n.title)}</td>
      <td>${n.scene || '--'}</td>
      <td>${n.city || '--'}</td>
      <td>${(n.likes || 0) + (n.comments || 0)}</td>
      <td>${renderRiskBar(n.emotion_risk)}</td>
    </tr>
  `).join('');
}

function renderRiskBar(level) {
  let html = '<span class="risk-bar">';
  for (let i = 1; i <= 5; i++) {
    const cls = i <= level ? (level >= 4 ? 'filled' : 'filled mid') : '';
    html += `<span class="seg ${cls}"></span>`;
  }
  html += `</span> <span style="font-size:11px;color:#5f6368">${level}/5</span>`;
  return html;
}

function renderAlerts(stats) {
  const container = document.getElementById('alertList');
  if (!container) return;
  const alerts = [];
  const sceneRank = stats.scene_rank || [];
  if (sceneRank.length > 0) {
    const top = sceneRank[0];
    alerts.push({ type: 'warning', title: `场景 "${top.name}" 负面最多`, reason: `${top.total} 条相关笔记，建议关注` });
  }
  const highRisk = stats.high_risk_notes || [];
  if (highRisk.length > 0) {
    const hr = highRisk[0];
    alerts.push({ type: 'danger', title: `高风险笔记：${hr.title?.substring(0, 30)}...`, reason: `风险等级 ${hr.emotion_risk}/5，城市 ${hr.city}，互动 ${(hr.likes||0)+(hr.comments||0)}` });
  }
  const negRatio = stats.negative_ratio || 0;
  if (negRatio > 40) {
    alerts.push({ type: 'warning', title: '负面声量占比偏高', reason: `近30天负面占比 ${negRatio}%，建议关注趋势` });
  }
  if (!alerts.length) {
    container.innerHTML = '<div class="alert-item alert-info">暂无异常预警</div>';
  } else {
    container.innerHTML = alerts.map(a => `
      <div class="alert-item alert-${a.type}" onclick="navigateTo('notes')">
        <div class="alert-item-title">${escHtml(a.title)}</div>
        <div class="alert-item-reason">${escHtml(a.reason)}</div>
      </div>
    `).join('');
  }
}

function renderCoverage(stats) {
  const container = document.getElementById('coverageInfo');
  if (!container) return;
  const kwStats = stats?.keyword_stats || [];
  if (!kwStats.length) {
    container.innerHTML = '<div class="coverage-placeholder">暂无采集数据，覆盖报告将在首次同步后生成</div>';
    return;
  }
  const totalKw = kwStats.length;
  const totalNotes = kwStats.reduce((s, k) => s + k.count, 0);
  container.innerHTML = `
    <div class="coverage-grid">
      <div class="coverage-item"><div class="coverage-item-label">关键词完成数</div><div class="coverage-item-value">${totalKw}</div></div>
      <div class="coverage-item"><div class="coverage-item-label">品牌相关笔记数</div><div class="coverage-item-value">${totalNotes}</div></div>
    </div>
  `;
}

// ─── 笔记库 ──────────────────────────────────────────────────────────────────

async function loadNotes(append = false) {
  if (!append) { noteOffset = 0; allNotes = []; }
  const params = new URLSearchParams();
  if (filterState.emotion) params.set('emotion', filterState.emotion);
  if (filterState.authorType) params.set('author_type', filterState.authorType);
  if (filterState.scene) params.set('scene', filterState.scene);
  if (filterState.city) params.set('city', filterState.city);
  if (filterState.keyword) params.set('keyword', filterState.keyword);
  if (filterState.dateFrom) params.set('date_from', filterState.dateFrom);
  if (filterState.dateTo) params.set('date_to', filterState.dateTo);
  params.set('limit', NOTE_LIMIT);
  params.set('offset', noteOffset);

  const data = await apiGet(`/api/notes?${params}`);
  if (!data) { showEmptyNotes(); return; }

  if (!append) {
    allNotes = data.notes || [];
  } else {
    allNotes = allNotes.concat(data.notes || []);
  }
  noteOffset += (data.notes || []).length;

  renderNotesList();
  updateFilterSummary(data.total);

  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) loadMoreBtn.style.display = allNotes.length < (data.total || 0) ? '' : 'none';
}

function renderNotesList() {
  const container = document.getElementById('notesList');
  if (!container) return;
  if (!allNotes.length) { showEmptyNotes(); return; }
  container.innerHTML = allNotes.map(n => `
    <div class="note-card" onclick="showNoteDetail('${n.id}')">
      <div class="note-card-header">
        <div class="note-card-title">${escHtml(n.title)}</div>
        <span class="badge badge-${n.emotion || 'neutral'}">${emoLabel(n.emotion)}</span>
      </div>
      <div class="note-card-meta">
        <span>📅 ${n.published_at || '--'}</span>
        <span>👤 ${escHtml(n.author || '未记录')}</span>
        <span>🏙️ ${n.city || '--'} <small style="color:#80868b">(${citySourceLabel(n.city_source)})</small></span>
        <span class="badge badge-${n.author_type || 'unknown'}">${authorTypeLabel(n.author_type)}</span>
        ${n.scene ? `<span>📂 ${escHtml(n.scene)}</span>` : ''}
        ${n.is_official_account ? `<span class="badge badge-official">疑似官方</span>` : ''}
      </div>
      <div class="note-card-content">${escHtml(n.content || n.title || '')}</div>
      ${n.images?.length ? `<div class="note-card-images">${n.images.slice(0, 3).map(u => `<img src="${escHtml(u)}" loading="lazy">`).join('')}</div>` : ''}
      <div class="note-card-footer">
        <span>❤️ ${n.likes || 0}</span>
        <span>💬 ${n.comments || 0}</span>
        <span>风险 ${n.emotion_risk || 1}/5</span>
        <span>关键词：${escHtml(n.keyword || '')}</span>
      </div>
    </div>
  `).join('');
}

function showEmptyNotes() {
  document.getElementById('notesList').innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      <div>暂无匹配的笔记</div>
      <div style="font-size:12px;margin-top:4px">尝试调整筛选条件或先执行一次同步</div>
    </div>
  `;
}

function updateFilterSummary(total) {
  const el = document.getElementById('filterSummary');
  if (!el) return;
  el.textContent = `共 ${total ?? allNotes.length} 条结果`;
}

function applyFilters() {
  filterState.emotion = document.getElementById('filterEmotion')?.value || '';
  filterState.authorType = document.getElementById('filterAuthorType')?.value || '';
  filterState.scene = document.getElementById('filterScene')?.value || '';
  filterState.city = document.getElementById('filterCity')?.value || '';
  filterState.keyword = document.getElementById('searchKeyword')?.value || '';
  filterState.dateFrom = document.getElementById('filterDateFrom')?.value || '';
  filterState.dateTo = document.getElementById('filterDateTo')?.value || '';
  loadNotes();
}

function resetFilters() {
  filterState = { emotion: '', authorType: '', scene: '', city: '', keyword: '', dateFrom: '', dateTo: '' };
  document.getElementById('filterEmotion').value = '';
  document.getElementById('filterAuthorType').value = '';
  document.getElementById('filterScene').value = '';
  document.getElementById('filterCity')?.remove();
  document.getElementById('searchKeyword').value = '';
  document.getElementById('filterDateFrom').value = '';
  document.getElementById('filterDateTo').value = '';
  loadNotes();
}

function loadMoreNotes() { loadNotes(true); }

// ─── 投诉场景 ────────────────────────────────────────────────────────────────

async function loadScenes() {
  const stats = await apiGet('/api/notes/stats');
  const container = document.getElementById('sceneList');
  if (!container || !stats) return;
  const sceneData = stats.scene_rank || [];
  const maxCount = sceneData.length ? sceneData[0].total : 1;
  const authorType = document.querySelector('.scene-tab.active')?.dataset.type || 'tenant';

  // 填充场景筛选
  const sceneFilter = document.getElementById('filterScene');
  if (sceneFilter && sceneFilter.options.length <= 1) {
    SCENES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s;
      sceneFilter.appendChild(opt);
    });
  }

  container.innerHTML = sceneData.map(s => {
    const pct = Math.round(s.total / maxCount * 100);
    return `
      <div class="scene-item" onclick="filterSceneClick('${s.name}')">
        <div class="scene-name">${escHtml(s.name)}</div>
        <div class="scene-count">${s.total}</div>
        <div class="scene-bar-wrap"><div class="scene-bar" style="width:${pct}%"></div></div>
        <div class="scene-meta">
          负${s.negative || 0} / 正${s.positive || 0}
        </div>
      </div>
    `;
  }).join('') || '<div class="empty-state"><div>暂无场景数据</div></div>';
}

function filterSceneClick(scene) {
  filterState.scene = scene;
  navigateTo('notes');
  applyFilters();
}

// 场景标签页
document.querySelectorAll('.scene-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.scene-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loadScenes();
  });
});

// ─── 搜索任务 ────────────────────────────────────────────────────────────────

async function loadTasks() {
  const status = await apiGet('/api/status');
  if (!status) return;
  document.getElementById('syncConnStatus').textContent =
    status.collector_status === 'collecting' ? '采集中' :
    status.collector_status === 'connected' ? '已连接' :
    status.collector_status === 'error' ? '异常' : '未连接';
  document.getElementById('syncSourceMode').textContent =
    status.source_mode === 'xhs_web_session' ? '小红书网页登录态' : '演示样本';
  document.getElementById('syncLastSync').textContent = status.last_sync ? new Date(status.last_sync).toLocaleString('zh-CN') : '从未';
  document.getElementById('syncStage').textContent = status.sync_stage || 'idle';
  document.getElementById('syncProgressText').textContent = `${status.sync_progress ?? 0}%`;
  document.getElementById('syncProgressBar').style.width = `${status.sync_progress ?? 0}%`;
  document.getElementById('syncCurrentKeyword').textContent = status.current_keyword || '--';
  const errRow = document.getElementById('syncErrorRow');
  if (status.last_error) {
    errRow.style.display = 'flex';
    document.getElementById('syncLastError').textContent = status.last_error;
  } else {
    errRow.style.display = 'none';
  }

  // 关键词矩阵
  const kwContainer = document.getElementById('keywordMatrix');
  if (kwContainer) {
    kwContainer.innerHTML = KEYWORDS.map(k => `<span class="keyword-tag">${escHtml(k)}</span>`).join('');
  }
}

// ─── 同步控制 ────────────────────────────────────────────────────────────────

async function requestSync() {
  if (isSyncing) return;
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = '同步中...';
  isSyncing = true;

  const result = await apiPost('/api/request-sync', {});
  if (result?.ok) {
    showToast('同步请求已发送，等待扩展处理...');
  } else {
    showToast('同步请求失败，请确认后端服务正在运行');
    btn.disabled = false;
    btn.textContent = '立即同步';
    isSyncing = false;
  }

  // 轮询状态
  const poll = setInterval(async () => {
    const status = await apiGet('/api/status');
    if (status?.sync_stage === 'idle' && status?.sync_progress === 100) {
      clearInterval(poll);
      isSyncing = false;
      btn.disabled = false;
      btn.textContent = '立即同步';
      showToast('同步完成！');
      loadTasks();
      loadOverview();
    } else if (status?.last_error) {
      clearInterval(poll);
      isSyncing = false;
      btn.disabled = false;
      btn.textContent = '立即同步';
      showToast('同步失败: ' + status.last_error);
    }
  }, 3000);

  // 5分钟后自动停止轮询
  setTimeout(() => clearInterval(poll), 300000);
}

// ─── 笔记详情 Modal ──────────────────────────────────────────────────────────

async function showNoteDetail(noteId) {
  const data = await apiGet(`/api/notes?keyword=&limit=1000`);
  const note = data?.notes?.find(n => n.id === noteId);
  if (!note) { alert('笔记未找到'); return; }

  document.getElementById('modalTitle').textContent = note.title || '笔记详情';
  document.getElementById('modalBody').innerHTML = `
    <div class="field"><div class="field-label">正文</div><div class="field-value">${escHtml(note.content || note.title || '')}</div></div>
    <div class="field"><div class="field-label">标题</div><div class="field-value">${escHtml(note.title)}</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
      <div class="field"><div class="field-label">作者</div><div class="field-value">${escHtml(note.author || '未记录')}</div></div>
      <div class="field"><div class="field-label">发布时间</div><div class="field-value">${note.published_at || '--'} <small style="color:#80868b">(${dateSourceLabel(note.date_source)})</small></div></div>
      <div class="field"><div class="field-label">城市</div><div class="field-value">${note.city || '--'} <small style="color:#80868b">(${citySourceLabel(note.city_source)})</small></div></div>
      <div class="field"><div class="field-label">发帖身份</div><div class="field-value">${authorTypeLabel(note.author_type)}</div></div>
      <div class="field"><div class="field-label">情绪</div><div class="field-value"><span class="badge badge-${note.emotion}">${emoLabel(note.emotion)}</span> 风险等级 ${note.emotion_risk}/5</div></div>
      <div class="field"><div class="field-label">场景</div><div class="field-value">${note.scene || '--'}</div></div>
      <div class="field"><div class="field-label">点赞 / 评论</div><div class="field-value">${note.likes || 0} / ${note.comments || 0}</div></div>
      <div class="field"><div class="field-label">命中关键词</div><div class="field-value">${escHtml(note.keyword || '--')}</div></div>
      <div class="field"><div class="field-label">疑似官方账号</div><div class="field-value">${note.is_official_account ? '是 (' + note.official_confidence + ') ' + (note.official_reason || '') : '否'}</div></div>
      <div class="field"><div class="field-label">正文来源</div><div class="field-value">${detailSourceLabel(note.detail_source)}</div></div>
    </div>
    ${note.images?.length ? `<div class="note-images" style="margin-top:12px">${note.images.map(u => `<img src="${escHtml(u)}">`).join('')}</div>` : ''}
  `;
  document.getElementById('noteModal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('noteModal').style.display = 'none';
}
document.getElementById('noteModal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('noteModal')) closeModal();
});

// ─── 导出 CSV ────────────────────────────────────────────────────────────────

async function exportCSV() {
  const params = new URLSearchParams();
  if (filterState.emotion) params.set('emotion', filterState.emotion);
  if (filterState.authorType) params.set('author_type', filterState.authorType);
  if (filterState.scene) params.set('scene', filterState.scene);
  if (filterState.city) params.set('city', filterState.city);
  const csv = await (await fetch(`${API}/export/csv?${params}`)).text();
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `省心租VOC导出_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadTemplate() {
  const header = '发布时间,标题,正文,作者,城市,城市来源,情绪,发帖身份,一级场景,点赞,评论,命中关键词,标签,图片,正文来源,是否疑似官方账号,官方判断依据,URL\n';
  const blob = new Blob(['﻿' + header], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'VOC导入模板.csv';
  a.click();
}

function handleCSVImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const text = e.target.result;
    const lines = text.split('\n').filter(l => l.trim());
    const header = lines[0].split(',').map(h => h.trim().replace(/﻿/g, ''));
    const notes = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 3) continue;
      const row = {};
      header.forEach((h, idx) => { row[h] = cols[idx]?.trim() || ''; });
      notes.push({
        id: `csv_${Date.now()}_${i}`,
        url: row['URL'] || '',
        title: row['标题'] || '',
        content: row['正文'] || '',
        published_at: row['发布时间'] || '',
        author: row['作者'] || '',
        keyword: row['命中关键词'] || '',
        likes: parseInt(row['点赞']) || 0,
        comments: parseInt(row['评论']) || 0,
        tags: (row['标签'] || '').split(';'),
        images: (row['图片'] || '').split(';').filter(Boolean),
        detail_source: row['正文来源'] || 'search_card',
      });
    }
    if (!notes.length) { alert('未能解析到有效数据，请检查 CSV 格式'); return; }
    const result = await apiPost('/api/ingest', {
      source: 'csv_import',
      trigger: 'manual',
      started_at: new Date().toISOString(),
      coverage: { import_method: 'csv', rows_parsed: notes.length },
      notes,
    });
    if (result?.ok) showToast(`CSV 导入成功：新增 ${result.inserted} 条，更新 ${result.updated} 条`);
    else showToast('导入失败，请检查后端服务');
  };
  reader.readAsText(file, 'UTF-8');
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emoLabel(e) {
  return { negative: '负面', positive: '正向', neutral: '中性' }[e] || e || '--';
}
function authorTypeLabel(t) {
  return { tenant: '租客', landlord: '业主', unknown: '待确认' }[t] || t || '--';
}
function citySourceLabel(s) {
  return { text_mention: '正文提及', author_ip: '作者IP', search_keyword: '搜索词', unknown: '未知' }[s] || s || '--';
}
function dateSourceLabel(s) {
  return { exact_date: '精确日期', approximate: '近似', relative: '相对', unknown: '未知' }[s] || s || '--';
}
function detailSourceLabel(s) {
  return { search_card: '搜索卡片', detail_page: '详情页' }[s] || s || '--';
}

function checkSourceMode() {
  apiGet('/api/status').then(status => {
    if (!status) return;
    const badge = document.getElementById('sourceBadge');
    if (badge) {
      if (status.source_mode === 'xhs_web_session') {
        badge.textContent = '真实数据';
        badge.className = 'source-badge live';
        document.getElementById('demoBanner').style.display = 'none';
      } else {
        badge.textContent = '演示数据';
        badge.className = 'source-badge demo';
        document.getElementById('demoBanner').style.display = '';
      }
    }
    // 更新采集状态指示
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (dot && text) {
      dot.className = 'status-dot ' + (status.collector_status === 'collecting' ? 'collecting' : status.collector_status === 'disconnected' ? '' : 'connected');
      const labels = { connected: '采集器已连接', collecting: '采集中...', disconnected: '采集器未连接', error: '采集异常' };
      text.textContent = labels[status.collector_status] || '未知';
    }
  });
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#323232;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;animation:fadeIn 0.2s';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showLoading(page) {
  // 由真实数据填充，此处仅作占位
}

function showDemoFallback(page) {
  // 如果 API 不可用，使用 localStorage 中的 demo 数据
  const demo = localStorage.getItem('voc_demo_notes');
  if (demo) {
    allNotes = JSON.parse(demo);
    renderNotesList();
  }
}

// ─── 初始化 ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  navigateTo('overview');
  loadOverview();
  checkSourceMode();

  // 每30秒轮询状态
  setInterval(() => {
    checkSourceMode();
    const activePage = document.querySelector('.page.active');
    if (activePage?.id === 'page-tasks') loadTasks();
  }, 30000);

  // ESC 关闭 modal
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
});
