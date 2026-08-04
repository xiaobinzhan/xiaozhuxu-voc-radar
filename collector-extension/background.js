// 省心租 VOC 采集器 - Background Service Worker
// 负责关键词矩阵采集、状态上报、断点恢复

const CONFIG = {
  serviceUrl: 'http://127.0.0.1:8000',
  scrollCount: 6,
  maxDetailPerKeyword: 6,
  pollIntervalMs: 5000,
  defaultKeywords: [
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
  ],
};

let state = {
  keywords: [...CONFIG.defaultKeywords],
  currentIndex: 0,
  isCollecting: false,
  status: 'disconnected',
  version: '1.0.0',
};

// ─── 状态上报 ─────────────────────────────────────────────────────────────────

async function reportStatus(extra = {}) {
  try {
    const resp = await fetch(`${CONFIG.serviceUrl}/api/collector-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collector_status: state.status,
        sync_stage: state.isCollecting ? 'collecting' : 'idle',
        sync_progress: state.keywords.length > 0
          ? Math.round((state.currentIndex / state.keywords.length) * 100)
          : 0,
        current_keyword: state.keywords[state.currentIndex] || '',
        current_keyword_index: state.currentIndex,
        keyword_total: state.keywords.length,
        collector_version: state.version,
        ...extra,
      }),
    });
    return await resp.json();
  } catch (e) {
    console.error('Status report failed:', e);
    return null;
  }
}

// ─── 采集逻辑 ─────────────────────────────────────────────────────────────────

async function pollForJobs() {
  try {
    const resp = await fetch(`${CONFIG.serviceUrl}/api/jobs/pending`);
    const data = await resp.json();
    if (data.jobs && data.jobs.length > 0) {
      const syncJob = data.jobs.find(j => j.type === 'sync');
      if (syncJob) {
        await runSync(syncJob);
      }
    }
  } catch (e) {
    console.error('Poll failed:', e);
  }
}

async function runSync(job) {
  state.isCollecting = true;
  state.status = 'collecting';
  await reportStatus({ last_error: '' });

  const startedAt = new Date().toISOString();
  const allNotes = [];
  let coverage = { keywords_total: state.keywords.length, keywords_completed: 0, visible_results: 0 };

  // 从断点恢复
  let startIndex = job.resume_keyword_index || 0;
  const resumeKeyword = job.resume_keyword || '';
  let startedAtResume = resumeKeyword ? state.keywords.indexOf(resumeKeyword) : startIndex;
  if (startedAtResume < 0) startedAtResume = startIndex;

  for (let i = startedAtResume; i < state.keywords.length; i++) {
    const keyword = state.keywords[i];
    state.currentIndex = i;
    await reportStatus({ last_error: '' });

    console.log(`[Collector] Searching: ${keyword}`);

    // 尝试通过 tabs API 搜索（需要用户先在小红书网页登录）
    const notes = await searchXiaohongshu(keyword);
    coverage.visible_results += notes.length;
    coverage.keywords_completed++;

    allNotes.push(...notes.map(n => ({ ...n, keyword })));

    // 每关键词等待短暂间隔，避免频率过高
    await sleep(1500);

    // 检测验证码/登录失效
    if (notes._captchaDetected) {
      coverage.last_error = '检测到验证码，已停止采集';
      await reportStatus({ last_error: '验证码检测，请人工处理后重试' });
      state.isCollecting = false;
      state.status = 'error';
      // 保存断点
      state.currentIndex = i;
      chrome.storage.local.set({ resume_keyword: keyword, resume_keyword_index: i });
      return;
    }
    if (notes._loginExpired) {
      coverage.last_error = '登录已失效';
      await reportStatus({ last_error: '登录失效，请重新登录小红书网页版' });
      state.isCollecting = false;
      state.status = 'error';
      return;
    }
  }

  // 采集完成，上报结果
  coverage.unique_results = allNotes.length;
  coverage.scroll_count = CONFIG.scrollCount;

  try {
    const ingestResp = await fetch(`${CONFIG.serviceUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'xhs_web_session',
        trigger: 'manual',
        started_at: startedAt,
        coverage,
        notes: allNotes.filter(n => !n._captchaDetected && !n._loginExpired),
      }),
    });
    const result = await ingestResp.json();
    console.log('[Collector] Ingest result:', result);
    await reportStatus({ last_error: '' });
  } catch (e) {
    await reportStatus({ last_error: `Ingest failed: ${e.message}` });
  }

  state.isCollecting = false;
  state.status = 'idle';
  state.currentIndex = 0;
  await reportStatus();
}

// ─── 小红书搜索采集（通过 content script 注入） ──────────────────────────────

async function searchXiaohongshu(keyword) {
  const notes = [];
  try {
    // 激活已有标签页或打开新标签
    const tab = await chrome.tabs.query({ url: 'https://www.xiaohongshu.com/search_result*' }).then(tabs => {
      return tabs.find(t => t.url?.includes(encodeURIComponent(keyword))) || null;
    });

    if (tab) {
      await chrome.tabs.update(tab.id, { active: true });
      await waitForTabReady(tab.id, 3000);
    } else {
      const newTab = await chrome.tabs.create({
        url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51`,
        active: true,
      });
      await waitForTabReady(newTab.id, 5000);
    }

    // 注入 content script 采集数据
    const results = await chrome.scripting.executeScript({
      target: { allFrames: true },
      func: () => {
        const items = [];
        // 尝试多种选择器
        const selectors = [
          '.search-note-item',
          '.feeds-page .note-item',
          '[data-note-id]',
          '.note-item-wrapper',
        ];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            const noteId = el.getAttribute('data-note-id') || el.getAttribute('href')?.match(/\/explore\/([a-f0-9]+)/)?.[1];
            if (!noteId) return;
            items.push({
              id: noteId,
              url: `https://www.xiaohongshu.com/explore/${noteId}`,
              title: el.querySelector('.note-title')?.textContent?.trim() || '',
              content: el.querySelector('.note-content')?.textContent?.trim() || '',
              author: el.querySelector('.author-name')?.textContent?.trim() || '',
              likes: parseInt(el.querySelector('.like-count')?.textContent || '0'),
              comments: parseInt(el.querySelector('.comment-count')?.textContent || '0'),
              image: el.querySelector('img')?.src || '',
            });
          });
          if (items.length > 0) break;
        }
        return items;
      },
    });

    const collected = results?.[0]?.result || [];
    if (collected.length === 0) {
      // 检查是否遇到验证码
      const captchaCheck = await chrome.scripting.executeScript({
        target: { allFrames: true },
        func: () => {
          const body = document.body.innerText || '';
          return {
            captcha: body.includes('验证码') || body.includes('滑动验证'),
            expired: body.includes('登录') && body.includes('扫码'),
          };
        },
      });
      const flags = captchaCheck?.[0]?.result || {};
      if (flags.captcha) collected._captchaDetected = true;
      if (flags.expired) collected._loginExpired = true;
    }

    return collected.map(n => ({
      ...n,
      published_at: '',
      date_source: 'unknown',
      city: '',
      city_source: 'unknown',
      tags: [],
      ip_location: '',
      images: n.image ? [n.image] : [],
      detail_source: 'search_card',
    }));
  } catch (e) {
    console.error('Search failed:', e);
    return [];
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForTabReady(tabId, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError) { resolve(); return; }
        if (Date.now() - start > timeout) { resolve(); return; }
        if (tab.status === 'complete') { resolve(); return; }
        setTimeout(check, 200);
      });
    };
    check();
  });
}

// ─── 初始化 ───────────────────────────────────────────────────────────────────

async function init() {
  // 恢复断点
  const saved = await chrome.storage.local.get(['resume_keyword', 'resume_keyword_index']);
  if (saved.resume_keyword) {
    state.currentIndex = saved.resume_keyword_index || 0;
  }

  // 初始状态上报
  await reportStatus();

  // 轮询
  setInterval(pollForJobs, CONFIG.pollIntervalMs);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Collector] Installed v' + CONFIG.version);
});

init();
