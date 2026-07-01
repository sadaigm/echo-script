// Popup: quick view, one card per video. Reads from the backend REST API.
const API = 'http://echoscript-server:8000'; // use http://localhost:8000 if the server is local
const listEl = document.getElementById('list');
let lastItems = [];

document.getElementById('startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.runtime.sendMessage({ type: 'START_FROM_POPUP', tabId: tab.id });
});

document.getElementById('stopBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP_FROM_POPUP' });
});

document.getElementById('refreshBtn').addEventListener('click', loadTranscripts);

// --- auto-refresh toggle (off by default, persisted) ---
const autoToggle = document.getElementById('autoToggle');
let poll = null;

function startPoll() {
  if (poll) return;
  poll = setInterval(loadTranscripts, 5000);
}

function stopPoll() {
  if (poll) { clearInterval(poll); poll = null; }
}

autoToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ autoRefresh: autoToggle.checked });
  if (autoToggle.checked) startPoll();
  else stopPoll();
});

// Restore preference on popup open
(async () => {
  const { autoRefresh = false } = await chrome.storage.local.get('autoRefresh');
  autoToggle.checked = autoRefresh;
  if (autoRefresh) startPoll();
  loadTranscripts();
})();

window.addEventListener('unload', stopPoll);

document.getElementById('managerBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  await fetch(`${API}/transcripts`, { method: 'DELETE' });
  loadTranscripts();
});

document.getElementById('exportBtn').addEventListener('click', exportAll);

// Per-card export (delegated)
listEl.addEventListener('click', (e) => {
  const id = e.target.dataset.id;
  if (!id || !e.target.classList.contains('exp')) return;
  const it = lastItems.find((x) => String(x.id) === id);
  if (it) downloadText(filename(it), formatItem(it));
});

async function loadTranscripts() {
  try {
    const res = await fetch(`${API}/transcripts`);
    lastItems = await res.json();
    render(lastItems);
  } catch (err) {
    listEl.innerHTML = `<div class="empty">Cannot reach server at ${API}.</div>`;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function render(items) {
  if (!items || !items.length) {
    listEl.innerHTML = '<div class="empty">No transcripts yet.</div>';
    return;
  }
  listEl.innerHTML = items.map((it) => {
    const time = (it.updated_at || it.created_at || '').slice(11, 19);
    return `
      <div class="item">
        <h4>${escapeHtml(it.title || '(no title)')} <span class="ts">${escapeHtml(time)}</span></h4>
        <div class="src">${escapeHtml(it.url || '')}</div>
        <p>${escapeHtml(it.text)}</p>
        ${it.ai ? `<p class="ai">AI: ${escapeHtml(it.ai)}</p>` : ''}
        <div class="actions"><button class="exp" data-id="${it.id}">Export this</button></div>
      </div>`;
  }).join('');
}

function formatItem(it) {
  const lines = [
    it.title || '(no title)',
    `URL: ${it.url || ''}`,
    `Updated: ${it.updated_at || it.created_at || ''}`,
    '----------------------------------------',
    '',
    it.text || '',
  ];
  if (it.ai) lines.push('', 'AI:', it.ai);
  return lines.join('\n');
}

function filename(it) {
  const base = (it.title || it.url || 'transcript')
    .replace(/https?:\/\//, '').replace(/[^\w\d\-]+/g, '_').slice(0, 60);
  return `${base || 'transcript'}.txt`;
}

function downloadText(name, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportAll() {
  if (!lastItems.length) return;
  const lines = [
    'EchoScript Transcripts',
    `Exported: ${new Date().toLocaleString()}`,
    '========================================',
    '',
  ];
  for (const it of lastItems) {
    lines.push(formatItem(it), '', '========================================', '');
  }
  downloadText('echoscript-all.txt', lines.join('\n'));
}
