// Offscreen document: captures tab audio, streams it to the backend over WS.
// Sends a 'source' control frame when the source video changes so the backend
// starts a new record (no merge across visits).

const WS_BASE = 'ws://echoscript-server:8000'; // use ws://localhost:8000 if the server is local

let ws;
let mediaRecorder;
let audioContext;
let liveStream = null;
let currentSource = { url: '', title: '', videoId: '' };

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'START_CAPTURE') {
    currentSource = { url: message.url || '', title: message.title || '', videoId: message.videoId || '' };
    startStreaming(message.streamId);
  } else if (message.type === 'STOP_CAPTURE') {
    stopStreaming();
  } else if (message.type === 'VIDEO_CHANGED') {
    currentSource = { url: message.url || '', title: message.title || '', videoId: message.videoId || '' };
    sendSourceFrame();
  }
});

// Tell the backend the source changed (mid-session) so it opens a new record.
function sendSourceFrame() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'source', ...currentSource }));
    console.log('EchoScript: sent source frame ->', currentSource.videoId);
  }
}

async function startStreaming(streamId) {
  console.log('EchoScript: START_CAPTURE, connecting WS...');

  // Initial source is passed as query params; later changes go via control frames.
  const params = new URLSearchParams();
  if (currentSource.url) params.set('url', currentSource.url);
  if (currentSource.title) params.set('title', currentSource.title);
  if (currentSource.videoId) params.set('videoId', currentSource.videoId);
  ws = new WebSocket(`${WS_BASE}/api/stream-flow?${params.toString()}`);

  ws.onerror = (e) => console.error('EchoScript: WebSocket error', e);
  ws.onclose = (e) => console.warn('EchoScript: WebSocket closed', e.code, e.reason);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'transcript') console.log('EchoScript: transcript =', msg.text);
      else if (msg.type === 'ai_response') console.log('EchoScript: ai_response =', msg.text);
    } catch (err) {
      console.error('EchoScript: failed to parse server message', err);
    }
  };

  ws.onopen = async () => {
    console.log('EchoScript: WebSocket connected');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    liveStream = stream;

    // Keep the captured audio audible
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(await event.data.arrayBuffer());
      }
    };
    mediaRecorder.start(1000); // 1-second chunks
    console.log('EchoScript: MediaRecorder started');
  };
}

function stopStreaming() {
  console.log('EchoScript: STOP_CAPTURE');
  try { if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop(); } catch (e) {}
  try { if (audioContext) audioContext.close(); } catch (e) {}
  try { if (ws) ws.close(); } catch (e) {}
  // Stop the tab-capture stream tracks — this releases the capture and
  // restores normal audio routing to the tab's speakers.
  if (liveStream) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
  }
  mediaRecorder = null;
  audioContext = null;
  ws = null;
}
