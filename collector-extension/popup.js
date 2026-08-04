// 扩展 Popup 逻辑
async function triggerSync() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = '发送请求中...';
  try {
    const resp = await fetch('http://127.0.0.1:8000/api/request-sync', { method: 'POST' });
    const data = await resp.json();
    const status = document.getElementById('status');
    status.textContent = '✓ 同步已触发';
    status.className = 'status ok';
    btn.textContent = '已发送';
  } catch (e) {
    const status = document.getElementById('status');
    status.textContent = '✗ 无法连接服务';
    status.className = 'status err';
    btn.disabled = false;
    btn.textContent = '立即同步';
  }
}

// 初始化
(async () => {
  const status = document.getElementById('status');
  try {
    const resp = await fetch('http://127.0.0.1:8000/api/status');
    const data = await resp.json();
    if (data.collector_status === 'collecting') {
      status.textContent = '采集中...';
      status.className = 'status ok';
    } else if (data.last_error) {
      status.textContent = '✗ ' + data.last_error;
      status.className = 'status err';
    } else {
      status.textContent = '✓ 已连接';
      status.className = 'status ok';
    }
  } catch {
    status.textContent = '✗ 服务未运行';
    status.className = 'status err';
  }
})();
