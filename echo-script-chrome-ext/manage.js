// Full-page manager: browse / search / export / delete every video transcript.
const API = 'http://10.0.0.100:8000'; // use http://localhost:8000 if the server is local
const listEl = document.getElementById('list');
const searchEl = document.getElementById('search');
const countEl = document.getElementById('count');
let items = [];

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('exportAll').addEventListener('click', exportAll);
document.getElementById('clearAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL transcripts? This cannot be undone.')) return;
  await fetch(`${API}/transcripts`, { method: 'DELETE' });
  load();
});
searchEl.addEventListener('input', render);

async function load() {
  try {
    const res = await fetch(`${API}/transcripts`);
    items = await res.json();
    render();
  } catch (e) {
    listEl.innerHTML = `<div class="empty">Cannot reach server at ${API}.</div>`;
    countEl.textContent = '';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const filtered = q
    ? items.filter((it) =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.text || '').toLowerCase().includes(q) ||
        (it.url || '').toLowerCase().includes(q))
    : items;

  countEl.textContent = `(${items.length} video${items.length === 1 ? '' : 's'})`;

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty">No transcripts${q ? ' match your search' : ''}.</div>`;
    return;
  }
  listEl.innerHTML = filtered.map((it) => `
    <div class="card">
      <h2>${escapeHtml(it.title || '(no title)')}</h2>
      <div class="meta">${escapeHtml(it.url || '(no url)')} · updated ${escapeHtml(it.updated_at || it.created_at || '')}</div>
      <div class="text">${escapeHtml(it.text)}</div>
      ${it.ai ? `<div class="text" style="color:#1565c0;font-style:italic;margin-top:8px">AI: ${escapeHtml(it.ai)}</div>` : ''}
      <div class="actions">
        <button class="exp" data-id="${it.id}">Export</button>
        <button class="del" data-id="${it.id}">Delete</button>
      </div>
    </div>
  `).join('');
}

// Delegated per-card actions
listEl.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  const it = items.find((x) => String(x.id) === id);
  if (!it) return;
  if (e.target.classList.contains('exp')) {
    downloadText(filename(it), formatItem(it));
  } else if (e.target.classList.contains('del')) {
    if (!confirm(`Delete "${it.title || it.url}"?`)) return;
    await fetch(`${API}/transcripts/${id}`, { method: 'DELETE' });
    load();
  }
});

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
  if (!items.length) return;
  const lines = [
    'EchoScript Transcripts',
    `Exported: ${new Date().toLocaleString()}`,
    '========================================',
    '',
  ];
  for (const it of items) {
    lines.push(formatItem(it), '', '========================================', '');
  }
  downloadText('echoscript-all.txt', lines.join('\n'));
}

load();
setInterval(load, 5000); // auto-refresh while the page is open
