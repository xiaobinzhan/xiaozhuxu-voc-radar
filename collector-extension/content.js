// 省心租 VOC 采集器 - Content Script
// 注入到小红书搜索结果页，采集笔记数据

(function () {
  'use strict';

  const SIGNAL_KEY = '__voc_collector_ready__';

  // 入口：等待页面加载完成后采集
  function init() {
    if (window[SIGNAL_KEY]) return;
    window[SIGNAL_KEY] = true;

    // 等待 DOM 就绪
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', collect);
    } else {
      collect();
    }
  }

  function collect() {
    const notes = extractNotes();
    if (notes.length > 0) {
      console.log(`[VOC Collector] Found ${notes.length} notes`);
      // 通知 background script
      chrome.runtime.sendMessage({ type: 'NOTES_COLLECTED', notes });
    }
  }

  function extractNotes() {
    const notes = [];
    // 小红书搜索结果页选择器
    const noteElements = document.querySelectorAll(
      '.note-item, [class*="note-item"], [data-note-id], .feeds-page .card, .search-result-item'
    );

    noteElements.forEach(el => {
      try {
        const href = el.querySelector('a[href*="/explore"]')?.getAttribute('href') || '';
        const idMatch = href.match(/\/explore\/([a-f0-9]+)/);
        const id = idMatch ? idMatch[1] : el.getAttribute('data-note-id') || '';
        if (!id) return;

        const title = el.querySelector('.note-title, [class*="title"]')?.textContent?.trim() || '';
        const content = el.querySelector('.note-content, [class*="content"], .note-text')?.textContent?.trim() || '';
        const author = el.querySelector('.author-name, [class*="author"]')?.textContent?.trim() || '';
        const likeText = el.querySelector('[class*="like"]')?.textContent?.trim() || '0';
        const commentText = el.querySelector('[class*="comment"]')?.textContent?.trim() || '0';
        const imgUrl = el.querySelector('img')?.src || '';

        notes.push({
          id,
          url: `https://www.xiaohongshu.com/explore/${id}`,
          title,
          content,
          author,
          likes: parseInt(likeText.replace(/\D/g, '')) || 0,
          comments: parseInt(commentText.replace(/\D/g, '')) || 0,
          images: imgUrl ? [imgUrl] : [],
          published_at: '',
          date_source: 'unknown',
          city: '',
          city_source: 'unknown',
          tags: [],
          ip_location: '',
          detail_source: 'search_card',
        });
      } catch (e) {
        console.warn('[VOC Collector] Failed to extract note:', e);
      }
    });

    return notes;
  }

  init();
})();
