// background.js (service worker)
//
// Detects when the captured tab navigates to a different video (including
// YouTube's in-page pushState navigation) and notifies the offscreen doc
// so the backend can start a fresh record.

// --- persisted captured-tab id -----------------------------------------
// The service worker is killed after ~30s of inactivity, so we cannot keep
// capturedTabId in a plain variable — it would be null by the time the user
// clicks another video.  Persist it in session storage.

async function getCapturedTabId() {
  const { capturedTabId = null } = await chrome.storage.session.get('capturedTabId');
  return capturedTabId;
}

async function setCapturedTabId(tabId) {
  if (tabId == null) {
    await chrome.storage.session.remove('capturedTabId');
  } else {
    await chrome.storage.session.set({ capturedTabId: tabId });
  }
}

// --- helpers ------------------------------------------------------------

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || url;
    return url; // non-YouTube: use the full URL as the id
  } catch {
    return url || '';
  }
}

let lastNotifiedUrl = ''; // dedupe between webNavigation + tabs.onUpdated

async function sendVideoChangedMsg(tabId, url, videoId) {
  let title = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title || '';
  } catch (_) { /* tab may be gone */ }
  console.log('EchoScript: VIDEO_CHANGED ->', videoId, '| title:', title);
  chrome.runtime.sendMessage({ type: 'VIDEO_CHANGED', url, title, videoId }).catch(() => {});
}

async function notifyVideoChanged(tabId, url) {
  if (!url) return;
  // Dedupe: both webNavigation and tabs.onUpdated may fire for the same nav.
  if (url === lastNotifiedUrl) return;
  lastNotifiedUrl = url;

  const videoId = extractVideoId(url);

  // Fire immediately so the backend switches video_id right away.
  // YouTube hasn't updated document.title yet, so the title may be stale.
  sendVideoChangedMsg(tabId, url, videoId);

  // Fire again after 2s — YouTube will have updated the title by then.
  setTimeout(() => sendVideoChangedMsg(tabId, url, videoId), 2000);
}

// --- navigation listeners ----------------------------------------------

// Primary: catches YouTube SPA navigation (history.pushState / replaceState)
// which tabs.onUpdated does NOT reliably fire for.
if (chrome.webNavigation && chrome.webNavigation.onHistoryStateChanged) {
  chrome.webNavigation.onHistoryStateChanged.addListener(async (details) => {
    if (details.frameId !== 0) return; // main frame only
    const capturedTabId = await getCapturedTabId();
    if (details.tabId !== capturedTabId) return;
    notifyVideoChanged(details.tabId, details.url);
  });
  console.log('EchoScript: webNavigation listener registered');
} else {
  console.warn('EchoScript: webNavigation API not available — SPA nav detection disabled. Remove & re-add the extension to grant the permission.');
}

// Backup: catches full-page navigations that some sites / edge-cases trigger.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const capturedTabId = await getCapturedTabId();
  if (tabId !== capturedTabId) return;
  notifyVideoChanged(tabId, changeInfo.url);
});

// --- popup → background messages ---------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_FROM_POPUP') {
    setCapturedTabId(message.tabId);
    startCapture(message.tabId);
  } else if (message.type === 'STOP_FROM_POPUP') {
    setCapturedTabId(null);
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {});
  }
});

// --- capture lifecycle --------------------------------------------------

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capturing tab audio to stream to Whisper backend',
  });
}

async function startCapture(tabId) {
  try {
    const streamId = await new Promise((resolve) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, resolve);
    });

    if (!streamId) {
      console.error('EchoScript: failed to obtain media stream ID');
      return;
    }

    const tab = await chrome.tabs.get(tabId);
    await ensureOffscreenDocument();

    await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId,
      url: tab.url || '',
      title: tab.title || '',
      videoId: extractVideoId(tab.url || ''),
    });
  } catch (err) {
    console.error('EchoScript: startCapture error', err);
  }
}
