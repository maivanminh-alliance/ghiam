import { compileRules, buildNormalizationSuggestions, buildVerificationQueue, computeGate, stripUnverifiedEvidence } from './guardrails.js?v=9.0.0';
import { exportDocx, exportPdf, exportCsv, exportSvg, buildReportBlocks } from './exporters.js?v=9.0.0';
import { ORGANIZATIONS, ORG_HINTS, checkHealth, validateHealth, transcribeFile, analyzeTranscript, rescueSegment, uniqueSpeakers, applySpeakerMap, parseEvidenceSeconds, evidenceLabel } from './enterprise-flow.js?v=9.0.0';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const HISTORY_KEY = 'meetingmind_pro_history_v1';
const SETTINGS_KEY = 'meetingmind_openai_settings_v1';
const API_KEY_STORAGE = 'meetingmind_openai_key';
const APP_VERSION = '9.0.0';
const GEMINI_KEY_STORAGE = 'meetingmind_gemini_key';
const CLAUDE_KEY_STORAGE = 'meetingmind_claude_key';
const SEGMENT_MS = 10 * 60 * 1000;
const MAX_RECORD_MS = 10 * 60 * 60 * 1000;
const DIRECT_UPLOAD_LIMIT = 24 * 1024 * 1024;

const state = {
  file: null, audioUrl: '', worker: null, transcript: [], notes: null, duration: 0,
  startedAt: 0, highlights: [], askHistory: [], images: [], usage: null,
  recording: false, mediaRecorder: null, recordSegments: [], recordSessionId: '', segmentIndex: 0,
  recordStartedAt: 0, recordTimer: null, segmentTimeout: null, wakeLock: null,
  paused: false, pauseStartedAt: 0, totalPausedMs: 0, segmentPausedMs: 0, segmentStart: 0,
  recordMarks: [], audioCtx: null, analyser: null, meterRaf: 0, recordStream: null,
  playback: null, playbackIndex: 0, recordSession: false, currentId: null, lastProgress: 0, appTab: 'record',
  // Enterprise V3
  rules: null, compiledRules: null, rawTranscript: [], normalizationLog: [], metrics: null, v3: null,
  verificationQueue: [], gate: null, blockedItems: [],
  // Enterprise V3.1 (backend hai bước)
  organization: 'Alliance', pendingTranscript: [], speakerMap: {}, documentStatus: '', officialExportAllowed: false,
  humanReview: null, backendNotes: null, analysisUsage: null, gateAnomaly: false, gateFull: false, approved: false,
};

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function bytes(size) { if (!size) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 3); return `${(size / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function clock(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60; return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
function humanDuration(seconds) { const n = Math.max(0, Math.round(Number(seconds) || 0)); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60; return [h ? `${h} giờ` : '', m ? `${m} phút` : '', `${s} giây`].filter(Boolean).join(' '); }
async function ensureAudioDuration() {
  const player = $('#audioPlayer');
  if (Number.isFinite(player.duration) && player.duration > 0) return player.duration;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); player.removeEventListener('loadedmetadata', done); resolve(); };
    const timer = setTimeout(done, 3000);
    player.addEventListener('loadedmetadata', done, { once: true });
  });
  state.duration = Number(player.duration) || state.duration || 0;
  return state.duration;
}
function factText(item) { return typeof item === 'string' ? item : String(item?.text || ''); }
function secondsFromTime(value) { const parts = String(value || '').split(':').map(Number); return parts.reduce((total, part) => total * 60 + (Number(part) || 0), 0); }
function evidenceHtml(item) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  if (!evidence.length) return '<span class="confidence-note">Chưa có mốc bằng chứng</span>';
  return `<span class="evidence-list">${evidence.map(time => {
    const row = state.transcript.find(entry => entry.time === time);
    return `<button class="evidence-chip" type="button" data-seconds="${row?.start ?? secondsFromTime(time)}">▶ ${escapeHtml(time)}</button>`;
  }).join('')}</span>`;
}

// ---------- Cài đặt & API key ----------
function getSettings() { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ engine: $('#engineSelect').value, organization: state.organization, sttModel: $('#sttModelSelect').value, summaryModel: $('#summaryModelSelect').value, claudeModel: $('#claudeModelSelect').value })); } catch {} }
function getApiKey() { try { return (localStorage.getItem(API_KEY_STORAGE) || '').trim(); } catch { return ''; } }
function getGeminiKey() { try { return (localStorage.getItem(GEMINI_KEY_STORAGE) || '').trim(); } catch { return ''; } }
function getClaudeKey() { try { return (localStorage.getItem(CLAUDE_KEY_STORAGE) || '').trim(); } catch { return ''; } }
function currentEngine() { return $('#engineSelect').value; }
function missingKeys() {
  const engine = currentEngine();
  if (engine === 'enterprise') return []; // backend giữ key, frontend không cần
  if (engine === 'gemini-claude') {
    const missing = [];
    if (!getGeminiKey()) missing.push('Gemini');
    if (!getClaudeKey()) missing.push('Claude');
    return missing;
  }
  return getApiKey() ? [] : ['OpenAI'];
}
function toggleEngineRows() {
  const engine = currentEngine();
  $('#rowOrganization').hidden = engine !== 'enterprise';
  $('#orgHint').hidden = engine !== 'enterprise';
  ['rowGeminiKey', 'rowClaudeKey', 'rowClaudeModel'].forEach(id => { $(`#${id}`).hidden = engine !== 'gemini-claude'; });
  ['rowOpenaiKey', 'rowSttModel', 'rowSummaryModel'].forEach(id => { $(`#${id}`).hidden = engine !== 'openai'; });
}
function updateApiStatus() {
  const engine = currentEngine();
  const missing = missingKeys();
  const ok = missing.length === 0;
  $('#apiBadge').textContent = engine === 'enterprise' ? 'BACKEND CÔNG TY' : (ok ? 'ĐÃ KẾT NỐI' : `THIẾU KEY ${missing.join(' + ')}`);
  $('#apiBadge').classList.toggle('api-badge-ok', ok);
  $('#deviceTitle').textContent = engine === 'enterprise' ? `Backend công ty · ${state.organization}`
    : ok ? (engine === 'gemini-claude' ? 'Đã kết nối Gemini + Claude' : 'Đã kết nối OpenAI') : 'Chưa đủ API key';
  $('#deviceCopy').textContent = engine === 'enterprise'
    ? 'Không có API key nào trong máy. Luồng: phiên âm → bạn sửa tên người nói → gpt-5.6-sol lập biên bản → bạn duyệt → xuất.'
    : ok
      ? (engine === 'gemini-claude' ? 'Gemini phiên âm tách người nói, Claude viết biên bản + sơ đồ. ~3.000–5.000đ mỗi giờ họp.' : 'Phiên âm tách người nói + GPT viết biên bản. ~10.000đ mỗi giờ ghi âm.')
      : `Dán key ${missing.join(' và ')} vào ô bên trên để bắt đầu.`;
  const hint = ORG_HINTS[state.organization] || '';
  $('#orgHint').textContent = `Công ty ${state.organization}: ${hint}`;
  toggleEngineRows();
}
async function loadAnomalyRules() {
  if (state.compiledRules) return state.rules;
  const response = await fetch(`./15_ASR_ANOMALY_RULES.json?v=${APP_VERSION}`);
  if (!response.ok) throw new Error('Không nạp được 15_ASR_ANOMALY_RULES.json.');
  state.rules = await response.json();
  state.compiledRules = compileRules(state.rules);
  return state.rules;
}
function loadSettings() {
  const saved = getSettings();
  if (saved.engine && $(`#engineSelect option[value="${saved.engine}"]`)) $('#engineSelect').value = saved.engine;
  if (saved.organization && ORGANIZATIONS.includes(saved.organization)) { state.organization = saved.organization; $('#organizationSelect').value = saved.organization; }
  if (saved.sttModel && $(`#sttModelSelect option[value="${saved.sttModel}"]`)) $('#sttModelSelect').value = saved.sttModel;
  if (saved.summaryModel && $(`#summaryModelSelect option[value="${saved.summaryModel}"]`)) $('#summaryModelSelect').value = saved.summaryModel;
  if (saved.claudeModel && $(`#claudeModelSelect option[value="${saved.claudeModel}"]`)) $('#claudeModelSelect').value = saved.claudeModel;
  $('#apiKeyInput').value = getApiKey();
  $('#geminiKeyInput').value = getGeminiKey();
  $('#claudeKeyInput').value = getClaudeKey();
  updateApiStatus();
}

// ---------- Giao diện chung ----------
function setProgress(percent, title, copy, stage = 1) {
  let p = Math.max(0, Math.min(100, Math.round(percent)));
  p = Math.max(p, state.lastProgress); state.lastProgress = p;
  $('#progressNumber').textContent = `${p}%`; $('#progressRing').style.setProperty('--p', p); $('#progressBar').style.width = `${p}%`;
  if (title) $('#progressTitle').textContent = title; if (copy) $('#progressCopy').textContent = copy;
  ['stageAudio', 'stageTranscript', 'stageNotes'].forEach((id, index) => { const el = $(`#${id}`); el.classList.toggle('done', index + 1 < stage); el.classList.toggle('active', index + 1 === stage); });
}
function showView(name) {
  $('#landingView').hidden = name !== 'landing'; $('#processingView').hidden = name !== 'processing'; $('#resultsView').hidden = name !== 'results';
  $('#speakerView').hidden = name !== 'speaker';
  $('#tabbar').hidden = name === 'processing' || name === 'speaker';
  if (name === 'results') { state.appTab = 'notes'; setTabbarActive('notes'); }
  if (name === 'landing') { if (state.appTab === 'notes') state.appTab = 'record'; toggleHomeTabs(state.appTab); setTabbarActive(state.appTab); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function setTabbarActive(name) { $$('#tabbar [data-apptab]').forEach(button => button.classList.toggle('active', button.dataset.apptab === name)); }
function toggleHomeTabs(which) { $('#tabRecord').hidden = which !== 'record'; $('#tabSettings').hidden = which !== 'settings'; $('#tabNotesEmpty').hidden = which !== 'notesEmpty'; }
function setAppTab(name) {
  state.appTab = name;
  if (name === 'notes' && state.notes) { $('#landingView').hidden = true; $('#processingView').hidden = true; $('#resultsView').hidden = false; }
  else {
    $('#landingView').hidden = false; $('#processingView').hidden = true; $('#resultsView').hidden = true;
    toggleHomeTabs(name === 'notes' ? 'notesEmpty' : name);
  }
  setTabbarActive(name);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showError(message, help = 'Kiểm tra API key, kết nối mạng, hoặc thử lại sau một phút.') { $('#errorMessage').textContent = message; $('#errorHelp').textContent = help; $('#errorDialog').showModal(); }

// ---------- IndexedDB cho bản ghi dài ----------
function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('meetingmind_recordings', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('segments')) request.result.createObjectStore('segments', { keyPath: 'key' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbPutSegment(segment) {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => { const tx = db.transaction('segments', 'readwrite'); tx.objectStore('segments').put(segment); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); }; });
}
async function dbAllSegments() {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => { const request = db.transaction('segments').objectStore('segments').getAll(); request.onsuccess = () => { db.close(); resolve(request.result || []); }; request.onerror = () => { db.close(); reject(request.error); }; });
}
async function dbClearSegments() {
  const db = await openRecordingDb();
  return new Promise((resolve, reject) => { const tx = db.transaction('segments', 'readwrite'); tx.objectStore('segments').clear(); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); }; });
}
async function checkRecovery() {
  try {
    const segments = await dbAllSegments();
    if (!segments.length) return;
    const total = segments.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    $('#recoveryMeta').textContent = `${segments.length} phần · ${humanDuration(total)} · ghi lúc ${new Date(segments[0].createdAt).toLocaleString('vi-VN')}`;
    $('#recoveryBanner').hidden = false;
  } catch {}
}

// ---------- Wake lock ----------
async function requestWakeLock() { try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
function releaseWakeLock() { try { state.wakeLock?.release(); } catch {} state.wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (state.recording && document.visibilityState === 'visible') requestWakeLock(); });

// ---------- Chọn file / bản ghi ----------
function clearPlayback() {
  (state.playback || []).forEach(item => { if (item.url) URL.revokeObjectURL(item.url); });
  state.playback = null; state.playbackIndex = 0; state.recordSession = false;
}
function setFile(file) {
  if (!file) return;
  const isM4a = /\.(m4a|mp4|aac)$/iu.test(file.name) || /mp4|aac/iu.test(file.type);
  if (file.size > 1536 * 1024 * 1024) return showError('File vượt quá giới hạn 1.5 GB.');
  if (!isM4a && file.size > 200 * 1024 * 1024) return showError('File MP3/WAV/WEBM lớn hơn 200 MB dễ gây thiếu bộ nhớ khi đọc trong trình duyệt.', 'Hãy chuyển sang M4A (Voice Memos xuất sẵn M4A) — định dạng này được đọc cuốn chiếu không tốn RAM.');
  clearPlayback();
  state.file = file; state.recordSegments = []; state.recordSession = false;
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); state.audioUrl = URL.createObjectURL(file);
  $('#audioPlayer').src = state.audioUrl; $('#resultAudio').src = state.audioUrl; $('#fileName').textContent = file.name; $('#fileMeta').textContent = `${bytes(file.size)} · ${file.type || 'Tệp âm thanh'}`;
  $('#dropzone').hidden = true; $('#fileCard').hidden = false; $('#startButton').disabled = false;
}
function removeFile() {
  state.file = null; $('#audioInput').value = ''; $('#audioPlayer').removeAttribute('src'); $('#resultAudio').removeAttribute('src');
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); state.audioUrl = '';
  clearPlayback(); state.recordSegments = [];
  $('#dropzone').hidden = false; $('#fileCard').hidden = true; $('#startButton').disabled = true;
}

async function decodeAudio(file) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (!AudioContextClass) throw new Error('Trình duyệt không hỗ trợ đọc âm thanh.');
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer()); state.duration = buffer.duration;
    const OfflineClass = window.OfflineAudioContext || window.webkitOfflineAudioContext; const offline = new OfflineClass(1, Math.ceil(buffer.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering(); return rendered.getChannelData(0).slice();
  } finally { await context.close().catch(() => {}); }
}

function createWorker() {
  if (state.worker) state.worker.terminate();
  const worker = new Worker(new URL(`./ai-worker.js?v=${APP_VERSION}`, import.meta.url), { type: 'module' }); state.worker = worker;
  worker.onmessage = handleWorkerMessage; worker.onerror = event => handleFailure(new Error(event.message || 'Worker gặp lỗi.')); return worker;
}

function generationContext() {
  return {
    template: $('#templateSelect').value,
    context: $('#contextInput').value.trim(),
    vocabulary: $('#vocabularyInput').value.trim(),
    images: state.images.map(file => file.name),
  };
}
function apiBaseMessage() {
  return {
    engine: currentEngine(),
    apiKey: getApiKey(),
    geminiKey: getGeminiKey(),
    claudeKey: getClaudeKey(),
    claudeModel: $('#claudeModelSelect').value,
    sttModel: $('#sttModelSelect').value,
    summaryModel: $('#summaryModelSelect').value,
    language: $('#languageSelect').value,
    vocabulary: $('#vocabularyInput').value.trim(),
    filename: state.file?.name || 'ghi-am',
  };
}

function wavBlobMain(float32, sampleRate = 16000) {
  const dataLength = float32.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeString = (pos, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(pos + i, text.charCodeAt(i)); };
  writeString(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, 'data'); view.setUint32(40, dataLength, true);
  let pos = 44;
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    pos += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

async function prepareGeminiParts() {
  if (state.recordSession && state.playback?.length) {
    const parts = [];
    for (let index = 0; index < state.playback.length; index += 1) {
      const item = state.playback[index];
      if (/webm|ogg/iu.test(item.mimeType || '')) {
        setProgress(4 + index / state.playback.length * 4, 'Đang chuyển đổi âm thanh…', `Phần ${index + 1}/${state.playback.length} sang WAV cho Gemini.`, 1);
        const pcm = await decodeAudio(item.blob);
        parts.push({ blob: wavBlobMain(pcm), mimeType: 'audio/wav', offset: item.offset });
      } else {
        parts.push({ blob: item.blob, mimeType: item.mimeType || 'audio/mp4', offset: item.offset });
      }
    }
    return parts;
  }
  const file = state.file;
  if (/webm/iu.test(file.type || '') || /\.webm$/iu.test(file.name)) {
    const duration = state.duration || await ensureAudioDuration();
    if (!duration || duration > 90 * 60) throw new Error('File WEBM dài không chuyển đổi được an toàn trong trình duyệt. Hãy dùng M4A/MP3/WAV/AAC.');
    setProgress(5, 'Đang chuyển đổi WEBM sang WAV…', 'Gemini không nhận WEBM trực tiếp.', 1);
    const pcm = await decodeAudio(file);
    return [{ blob: wavBlobMain(pcm), mimeType: 'audio/wav', offset: 0 }];
  }
  return [{ blob: file, mimeType: file.type || 'audio/mp4', offset: 0 }];
}

async function startAnalysis() {
  if (!state.file && !state.recordSession) return;
  const missing = missingKeys();
  if (missing.length) { setAppTab('settings'); return showError(`Chưa nhập API key ${missing.join(' và ')}.`, 'Dán key vào tab Cài đặt. Gemini: aistudio.google.com/apikey · Claude: console.anthropic.com/settings/keys · OpenAI: platform.openai.com/api-keys.'); }
  showView('processing'); state.startedAt = Date.now(); state.highlights = []; state.askHistory = []; state.usage = null; state.lastProgress = 0;
  setProgress(3, 'Đang chuẩn bị âm thanh…', 'Giao diện đã nhận lệnh. Vui lòng không đóng tab.', 1);
  await new Promise(resolve => { const timer = setTimeout(resolve, 150); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
  try {
    const base = apiBaseMessage();
    if (state.recordSession && state.playback?.length) {
      state.duration = state.playback.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    }
    // ===== Engine Enterprise (backend công ty, luồng 2 bước) =====
    if (base.engine === 'enterprise') {
      await runEnterpriseTranscribe();
      return;
    }
    // ===== Engine Gemini + Claude: gửi nguyên file (tới 9,5 giờ/lần), không cần cắt 10 phút =====
    if (base.engine === 'gemini-claude') {
      const duration = state.recordSession ? state.duration : (state.duration || await ensureAudioDuration());
      if (duration > 9.5 * 3600) throw new Error('Gemini nhận tối đa 9,5 giờ âm thanh mỗi lần. Hãy chia file trước.');
      if (!state.recordSession && state.file.size > 1900 * 1024 * 1024) throw new Error('File vượt giới hạn 2 GB của Gemini.');
      const uploadParts = await prepareGeminiParts();
      setProgress(8, 'Đang gửi âm thanh tới Gemini…', 'File được tải lên Google AI qua HTTPS.', 2);
      createWorker().postMessage({ type: 'transcribe', ...base, durationSeconds: duration, uploadParts });
      return;
    }
    // ===== Engine OpenAI (như V7) =====
    if (state.recordSession && state.playback?.length) {
      createWorker().postMessage({ type: 'transcribe', ...base, filename: state.file?.name || 'ghi-am.webm', parts: state.playback.map(item => ({ blob: item.blob, offset: item.offset, mimeType: item.mimeType })) });
      return;
    }
    const duration = state.duration || await ensureAudioDuration();
    const isM4a = /\.(m4a|mp4|aac)$/iu.test(state.file.name) || /mp4|aac/iu.test(state.file.type || '');
    if (state.file.size <= DIRECT_UPLOAD_LIMIT) {
      setProgress(8, 'Đang tải file lên OpenAI…', `${bytes(state.file.size)} · gửi trực tiếp qua HTTPS.`, 2);
      createWorker().postMessage({ type: 'transcribe', ...base, file: state.file });
    } else if (isM4a) {
      setProgress(5, 'Đang đọc file M4A cuốn chiếu…', 'File lớn được cắt thành phần 10 phút rồi gửi lần lượt tới OpenAI.', 1);
      createWorker().postMessage({ type: 'transcribe', ...base, file: state.file, stream: true });
    } else {
      if (!duration || duration > 90 * 60) throw new Error('File MP3/WAV dài không đọc được an toàn trong trình duyệt. Hãy chuyển sang M4A rồi thử lại.');
      setProgress(6, 'Đang giải mã âm thanh…', 'Chuyển về 16 kHz trước khi gửi tới OpenAI.', 1);
      const audio = await decodeAudio(state.file);
      createWorker().postMessage({ type: 'transcribe', ...base, audio }, [audio.buffer]);
    }
  } catch (error) { handleFailure(error); }
}

// ============ Enterprise V3.1 — luồng backend hai bước ============
async function enterpriseAudioBlob() {
  // File tải lên: gửi nguyên. Bản ghi trực tiếp: ghép các phần thành 1 WAV liên tục (speaker nhất quán).
  if (!state.recordSession) return state.file;
  setProgress(5, 'Đang ghép các phần ghi âm…', 'Chuyển về một file âm thanh liên tục.', 1);
  const pcms = [];
  let total = 0;
  for (const item of state.playback) { const pcm = await decodeAudio(item.blob); pcms.push(pcm); total += pcm.length; }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const pcm of pcms) { merged.set(pcm, offset); offset += pcm.length; }
  return new File([wavBlobMain(merged)], (state.file?.name || 'ghi-am') + '.wav', { type: 'audio/wav' });
}

async function runEnterpriseTranscribe() {
  // Kiểm tra /health trước (yêu cầu file 17/20)
  setProgress(4, 'Đang kiểm tra backend…', 'GET /health', 1);
  let health;
  try { health = await checkHealth(); } catch (error) { throw new Error(`Không gọi được backend /health: ${error.message}`); }
  const valid = validateHealth(health);
  if (!valid.ok) throw new Error(valid.reason);
  const audio = await enterpriseAudioBlob();
  if (!audio) throw new Error('Chưa có file âm thanh để phiên âm.');
  if (!state.recordSession) state.duration = state.duration || await ensureAudioDuration();
  setProgress(12, 'Đang tải file lên backend…', `${bytes(audio.size)} · gpt-4o-transcribe-diarize.`, 1);
  const result = await transcribeFile(audio);
  if (!result.transcript.length || !result.transcript.some(row => String(row.text || '').trim())) {
    throw new Error('Backend trả transcript rỗng — không thể tiếp tục.');
  }
  setProgress(40, 'Phiên âm xong', 'Chờ bạn xác nhận tên người nói.', 2);
  state.pendingTranscript = result.transcript.map(row => ({ ...row, originalSpeaker: row.originalSpeaker || row.speaker }));
  state.documentStatus = 'speaker_review';
  state.speakerMap = {};
  renderSpeakerReview();
  showView('speaker');
}

function renderSpeakerReview() {
  const speakers = uniqueSpeakers(state.pendingTranscript);
  $('#speakerList').innerHTML = speakers.map(sp => `
    <div class="speaker-item" data-speaker="${escapeHtml(sp.label)}">
      <div class="row"><span class="row-label">${escapeHtml(sp.label)}</span><input class="row-input speaker-name" data-speaker="${escapeHtml(sp.label)}" placeholder="Tên thật (để trống nếu chưa rõ)" value="${escapeHtml(state.speakerMap[sp.label] || '')}" style="text-align:left"></div>
      <div class="speaker-samples">${sp.samples.map(sample => `<button class="sample-line" type="button" data-seconds="${Number(sample.start) || 0}"><span>${escapeHtml(sample.time)}</span> ${escapeHtml(sample.text.slice(0, 90))}</button>`).join('')}</div>
    </div>`).join('') || '<div class="row"><span class="row-body">Không tách được người nói.</span></div>';
}

async function confirmSpeakersAndAnalyze() {
  // Thu speakerMap từ input
  state.speakerMap = {};
  $$('.speaker-name').forEach(input => { const name = input.value.trim(); if (name) state.speakerMap[input.dataset.speaker] = name; });
  const named = applySpeakerMap(state.pendingTranscript, state.speakerMap);
  showView('processing');
  state.startedAt = Date.now(); state.lastProgress = 0;
  setProgress(55, 'Đang phân tích biên bản…', 'gpt-5.6-sol đọc toàn bộ transcript đã xác nhận tên.', 3);
  try {
    const data = await analyzeTranscript({ filename: state.file?.name || 'ghi-am.m4a', organization: state.organization, transcript: named, speakerMap: state.speakerMap });
    applyEnterpriseResult(data);
  } catch (error) { handleFailure(error); }
}

function applyEnterpriseResult(data) {
  const notes = data.notes || {};
  state.backendNotes = notes;
  state.transcript = (data.transcript || []).map(row => ({ ...row, speaker: row.speaker || row.originalSpeaker || 'Người nói' }));
  state.rawTranscript = (data.transcript || []).map(row => ({ ...row }));
  state.normalizedTranscriptData = data.normalizedTranscript || [];
  state.documentStatus = data.documentStatus || notes.generation?.documentStatus || 'ai_draft';
  state.officialExportAllowed = Boolean(data.officialExportAllowed);
  state.humanReview = notes.humanReview || null;
  state.analysisUsage = data.usage || null;
  state.v3 = notes; // schema 3.1 đầy đủ để render tab
  state.metrics = enterpriseMetrics(notes, data);
  state.verificationQueue = (notes.verificationQueue || []).map((item, i) => ({ id: item.id || `vq${i + 1}`, group: vqGroup(item.type), resolved: item.status === 'confirmed' || item.status === 'corrected' || item.status === 'accepted_with_note', kind: 'backend_vq', backendType: item.type, description: item.description, evidence: item.evidence || [], priority: item.priority, segmentId: item.segmentId, status: item.status || 'pending' }));
  state.anomalies = data.anomalies || [];
  // Map notes (schema 3.1 đã có alias title/summary/keyPoints) sang notes legacy để UI cũ dùng
  state.notes = {
    title: notes.title || notes.meeting?.title || (state.file?.name || 'Cuộc họp').replace(/\.[^.]+$/, ''),
    summary: notes.summary || notes.executiveSummary || '',
    keyPoints: (notes.keyPoints || notes.facts || []).map(mapEvidenceItem),
    decisions: (notes.decisions || []).map(mapEvidenceItem),
    actions: (notes.actions || []).map(mapEvidenceItem),
    risks: (notes.risks || []).map(mapEvidenceItem),
    mindmap: '', // backend trả mindMap dạng object → render riêng
    coverage: notes.coverage || null,
  };
  // Trạng thái duyệt từ backend (không để AI tự duyệt)
  state.gateAnomaly = state.humanReview?.anomalyReviewStatus === 'reviewed';
  state.gateFull = state.humanReview?.fullDocumentReviewStatus === 'reviewed';
  state.approved = false; state.usage = { inputTokens: data.usage?.analysis?.input_tokens || 0, outputTokens: data.usage?.analysis?.output_tokens || 0, usd: data.usage?.analysisEstimatedUsd || 0 };
  refreshGate(false);
  if (state.recordSession) dbClearSegments().catch(() => {});
  setProgress(100, 'Bản nháp đã sẵn sàng', 'BẢN NHÁP AI — CHƯA PHÊ DUYỆT. Kiểm tra 2 cổng duyệt.', 3);
  setTimeout(renderResults, 300);
}

function mapEvidenceItem(item) {
  // Backend evidence là chuỗi "MM:SS — Tên: ..."; chuyển thành mảng nhãn MM:SS để chip dùng, giữ chuỗi gốc
  const evList = (item.evidence || []).map(evidenceLabel).filter(Boolean);
  return { ...item, evidence: evList, evidenceRaw: item.evidence || [], _seconds: (item.evidence || []).map(parseEvidenceSeconds) };
}
function vqGroup(type) {
  return ({ high_risk_fact: 'Số liệu / tiền / ngày / cam kết', domain_anomaly: 'Câu ngoài ngữ cảnh', repetition: 'Câu lặp / bất thường', name_entity: 'Tên người / đơn vị', unit_code: 'Mã căn / hạng mục', speaker_unknown: 'Speaker chưa xác định', conflict: 'Mâu thuẫn' }[type]) || 'Cần xác minh khác';
}
function enterpriseMetrics(notes, data) {
  const q = notes.quality || {};
  return {
    totalSegments: (data.transcript || []).length,
    anomalySegments: (data.anomalies || []).length,
    anomalySeconds: Math.round(q.anomalyDurationSeconds || 0),
    anomalyRate: (q.anomalyRate || 0) / (q.anomalyRate > 1 ? 100 : 1),
    lowConfidenceRate: 0,
    speakerCoverage: (q.speakerCoverage || 0) / 100,
    audioCoverage: (q.transcriptCoverage || 0) / 100,
    evidenceCoverage: (q.evidenceCoverage || 0) / 100,
    gaps: [],
    fromBackend: true,
  };
}

function handleWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === 'progress') {
    if (message.phase === 'container-read') setProgress(4 + message.value * .06, 'Đang đọc cấu trúc M4A theo từng phần…', message.detail || 'Không nạp toàn bộ file vào RAM.', 1);
    if (message.phase === 'audio-decode') setProgress(10 + message.value * .25, 'Đang giải mã và gửi cuốn chiếu…', message.detail || 'Chuẩn bị âm thanh 16 kHz.', 2);
    if (message.phase === 'asr-run') setProgress(12 + message.value * .58, 'Đang phiên âm qua OpenAI…', message.detail || 'Whisper đang nghe và tách người nói.', 2);
    if (message.phase === 'llm-run') setProgress(72 + message.value * .27, 'GPT đang viết biên bản…', message.detail || 'Trích xuất quyết định, rủi ro và đầu việc.', 3);
    return;
  }
  if (message.type === 'transcript') {
    if (!Array.isArray(message.transcript) || !message.transcript.some(row => String(row.text || '').trim())) {
      handleFailure(new Error('Không tạo được transcript từ file này — không thể tiếp tục (transcript rỗng).'));
      return;
    }
    state.transcript = message.transcript.map(row => ({ ...row, speaker: row.speaker || 'Người nói 1' }));
    if (message.enterprise) {
      // rawTranscript giữ nguyên vĩnh viễn; normalized = state.transcript (sửa có kiểm soát qua hàng chờ)
      state.rawTranscript = message.transcript.map(row => ({ start: row.start, end: row.end, time: row.time, speaker: row.speaker, text: row.text, confidence: row.confidence ?? null, status: row.status, anomalies: row.anomalies || [], rescue: row.rescue || null }));
      state.metrics = message.metrics || null;
      const suggestions = buildNormalizationSuggestions(state.transcript);
      state.verificationQueue = buildVerificationQueue(state.transcript, suggestions, state.compiledRules || compileRules(state.rules || {}));
      state.normalizationLog = [];
    } else { state.rawTranscript = []; state.metrics = null; state.verificationQueue = []; state.v3 = null; }
    setProgress(72, 'Transcript đã hoàn tất', 'Đang tạo biên bản theo mẫu đã chọn.', 3);
    state.worker.postMessage({ type: 'summarize', transcript: state.transcript, ...apiBaseMessage(), ...generationContext() });
    return;
  }
  if (message.type === 'result') {
    state.notes = message.notes; state.usage = message.usage || null; state.v3 = message.v3 || null;
    if (state.recordMarks?.length) state.highlights = state.recordMarks.map(mark => ({ time: mark.time, note: mark.note || 'Đánh dấu khi đang ghi', createdAt: mark.createdAt }));
    // Chặn decision/action tham chiếu đoạn cách ly chưa xác minh (prohibitedActions)
    state.blockedItems = [];
    if (state.metrics && state.notes) {
      for (const key of ['decisions', 'actions']) {
        const { kept, blocked } = stripUnverifiedEvidence(state.notes[key], state.transcript);
        state.notes[key] = kept;
        blocked.forEach(item => state.blockedItems.push({ kind: key, ...item }));
      }
    }
    refreshGate(Boolean(message.fallback));
    // Trung thực về tiến độ: KHÔNG báo 100% nếu phân tích lỗi hoặc còn mục chưa xác minh (yêu cầu 16)
    if (state.gate && !state.gate.releasable) {
      state.lastProgress = 0;
      setProgress(97, 'Hoàn tất — cần xác minh', `${state.gate.unresolvedCount} mục trong hàng chờ xác minh trước khi phát hành biên bản.`, 3);
    } else {
      setProgress(100, 'Biên bản đã hoàn tất', 'Toàn bộ transcript đã được AI đọc một lượt.', 3);
    }
    if (state.recordSession) dbClearSegments().catch(() => {});
    setTimeout(renderResults, 400); return;
  }
  if (message.type === 'answer') {
    state.askHistory.push({ role: 'answer', text: message.answer, references: message.references || [] }); renderAskHistory(); $('#askInput').disabled = false; $('#askForm button').disabled = false; return;
  }
  if (message.type === 'error') handleFailure(new Error(message.error || 'Không thể xử lý qua OpenAI.'));
}

function handleFailure(error) {
  if (state.worker) state.worker.terminate(); state.worker = null; showView('landing');
  showError(error.message || 'Không thể xử lý file.');
}

// ---------- Ghi âm dài phân đoạn ----------
function pickRecorderMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'];
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}
function recordElapsedMs() {
  return Date.now() - state.recordStartedAt - state.totalPausedMs - (state.paused ? Date.now() - state.pauseStartedAt : 0);
}
function updateRecordUi() {
  const elapsed = recordElapsedMs();
  $('#recordTime').textContent = clock(elapsed / 1000);
  $('#blackoutTime').textContent = clock(elapsed / 1000);
  const savedBytes = state.recordSegments.reduce((sum, item) => sum + (item.blob?.size || 0), 0);
  $('#recordPart').textContent = `Phần ${state.segmentIndex + 1}${state.recordSegments.length ? ` · đã lưu an toàn ${state.recordSegments.length} phần (${bytes(savedBytes)})` : ''}`;
  if (elapsed >= MAX_RECORD_MS && state.recording) { stopRecording(); showError('Đã đạt giới hạn ghi liên tục 10 giờ.', 'Bản ghi được giữ nguyên và sẵn sàng phân tích. Bạn có thể bắt đầu phiên ghi mới sau khi xử lý xong.'); }
}
async function toggleRecording() {
  if (state.recording) { stopRecording(); return; }
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Trình duyệt không hỗ trợ ghi âm trực tiếp.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await dbClearSegments().catch(() => {});
    $('#recoveryBanner').hidden = true;
    state.recording = true; state.recordSessionId = crypto.randomUUID(); state.recordSegments = []; state.segmentIndex = 0; state.recordStartedAt = Date.now();
    state.paused = false; state.totalPausedMs = 0; state.recordMarks = []; state.recordStream = stream;
    requestWakeLock();
    $('#recordButton').classList.add('recording'); $('#recordLabel').textContent = 'Đang ghi — chạm nút đỏ để dừng';
    $('#recordActions').hidden = false; $('#pauseButton').textContent = '⏸ Tạm dừng'; $('#markCount').textContent = '';
    state.recordTimer = setInterval(updateRecordUi, 500);
    startMeter(stream);
    startSegmentRecorder(stream);
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || /denied|permission/iu.test(error?.message || '');
    showError(denied ? 'Chưa được cấp quyền micro.' : (error.message || 'Không thể truy cập micro.'), 'Hãy cấp quyền Micro cho website này trong cài đặt trình duyệt (iPhone: Cài đặt → Safari → Micrô).');
  }
}
function startSegmentRecorder(stream) {
  const mimeType = pickRecorderMime();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  state.mediaRecorder = recorder;
  const chunks = []; const index = state.segmentIndex;
  state.segmentStart = Date.now(); state.segmentPausedMs = 0;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => { state.recording = false; state.paused = false; clearInterval(state.recordTimer); clearTimeout(state.segmentTimeout); stream.getTracks().forEach(track => track.stop()); stopMeter(); exitBlackout(); releaseWakeLock(); resetRecordButton(); showError('Ghi âm bị gián đoạn.', state.recordSegments.length ? `Đã lưu an toàn ${state.recordSegments.length} phần — bấm Khôi phục để dùng phần đã ghi.` : 'Hãy thử lại.'); checkRecovery(); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    const duration = (Date.now() - state.segmentStart - state.segmentPausedMs) / 1000;
    if (blob.size > 0 && duration > 0.5) {
      const segment = { key: `${state.recordSessionId}:${String(index).padStart(4, '0')}`, sessionId: state.recordSessionId, index, blob, duration, mimeType: blob.type, createdAt: Date.now() };
      state.recordSegments.push(segment);
      try { await dbPutSegment(segment); } catch {}
    }
    if (state.recording) { state.segmentIndex += 1; startSegmentRecorder(stream); }
    else finishRecording(stream);
  };
  recorder.start(1000);
  clearTimeout(state.segmentTimeout);
  state.segmentTimeout = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, SEGMENT_MS);
}
function stopRecording() {
  if (state.paused && state.pauseStartedAt) { const pausedFor = Date.now() - state.pauseStartedAt; state.totalPausedMs += pausedFor; state.segmentPausedMs += pausedFor; state.paused = false; }
  state.recording = false; clearTimeout(state.segmentTimeout); clearInterval(state.recordTimer);
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
}
function togglePause() {
  if (!state.recording || !state.mediaRecorder) return;
  if (!state.paused) {
    state.paused = true; state.pauseStartedAt = Date.now();
    clearTimeout(state.segmentTimeout);
    if (state.mediaRecorder.state === 'recording') state.mediaRecorder.pause();
    $('#pauseButton').textContent = '▶ Tiếp tục'; $('#recordLabel').textContent = 'Đã tạm dừng — chạm Tiếp tục để ghi tiếp';
    $('#recordButton').classList.add('paused');
  } else {
    const pausedFor = Date.now() - state.pauseStartedAt;
    state.totalPausedMs += pausedFor; state.segmentPausedMs += pausedFor; state.paused = false;
    if (state.mediaRecorder.state === 'paused') state.mediaRecorder.resume();
    const recorder = state.mediaRecorder;
    const remaining = Math.max(2000, SEGMENT_MS - (Date.now() - state.segmentStart - state.segmentPausedMs));
    state.segmentTimeout = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, remaining);
    $('#pauseButton').textContent = '⏸ Tạm dừng'; $('#recordLabel').textContent = 'Đang ghi — chạm nút đỏ để dừng';
    $('#recordButton').classList.remove('paused');
  }
}
function addRecordMark() {
  if (!state.recording) return;
  state.recordMarks.push({ time: Math.max(0, recordElapsedMs() / 1000), note: '', createdAt: Date.now() });
  $('#markCount').textContent = String(state.recordMarks.length);
}
function startMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
    state.audioCtx = new Ctx();
    const source = state.audioCtx.createMediaStreamSource(stream);
    state.analyser = state.audioCtx.createAnalyser(); state.analyser.fftSize = 128; state.analyser.smoothingTimeConstant = 0.7;
    source.connect(state.analyser);
    const canvas = $('#meterCanvas'); canvas.hidden = false;
    const g = canvas.getContext('2d');
    const data = new Uint8Array(state.analyser.frequencyBinCount);
    const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || '#FF3B30';
    const draw = () => {
      if (!state.recording) return;
      state.analyser.getByteFrequencyData(data);
      const w = canvas.width, h = canvas.height, bars = 32, step = Math.max(1, Math.floor(data.length / bars));
      g.clearRect(0, 0, w, h);
      g.fillStyle = red; g.globalAlpha = state.paused ? 0.25 : 0.9;
      for (let i = 0; i < bars; i += 1) {
        const level = data[i * step] / 255;
        const barHeight = Math.max(3, level * h);
        g.fillRect(i * (w / bars) + 2, (h - barHeight) / 2, w / bars - 4, barHeight);
      }
      state.meterRaf = requestAnimationFrame(draw);
    };
    draw();
  } catch {}
}
function stopMeter() {
  cancelAnimationFrame(state.meterRaf);
  try { state.audioCtx?.close(); } catch {}
  state.audioCtx = null; state.analyser = null;
  const canvas = $('#meterCanvas'); canvas.hidden = true;
}
function enterBlackout() { if (state.recording) $('#blackout').hidden = false; }
function exitBlackout() { $('#blackout').hidden = true; }
function resetRecordButton() { $('#recordButton').classList.remove('recording'); $('#recordLabel').textContent = 'Chạm để bắt đầu ghi âm'; $('#recordPart').textContent = ''; $('#recordTime').textContent = '00:00'; }
function finishRecording(stream) {
  stream.getTracks().forEach(track => track.stop()); releaseWakeLock(); resetRecordButton(); state.mediaRecorder = null; state.recordStream = null;
  stopMeter(); exitBlackout(); $('#recordActions').hidden = true;
  if (!state.recordSegments.length) return showError('Bản ghi rỗng.', 'Hãy nói ít nhất vài giây trước khi bấm dừng.');
  applyRecordedSession(state.recordSegments);
}
function applyRecordedSession(segments) {
  clearPlayback();
  const sorted = [...segments].sort((a, b) => a.index - b.index);
  let offset = 0;
  state.playback = sorted.map(item => { const entry = { url: URL.createObjectURL(item.blob), blob: item.blob, offset, duration: Number(item.duration) || 0, mimeType: item.mimeType }; offset += entry.duration; return entry; });
  state.duration = offset; state.recordSession = true; state.recordSegments = sorted;
  const totalBytes = sorted.reduce((sum, item) => sum + (item.blob?.size || 0), 0);
  const ext = (sorted[0].mimeType || '').includes('mp4') ? 'm4a' : 'webm';
  state.file = new File([sorted[0].blob], `Ghi âm ${new Date(sorted[0].createdAt).toLocaleString('vi-VN').replace(/[/:]/g, '-')}.${ext}`, { type: sorted[0].mimeType });
  $('#fileName').textContent = state.file.name;
  $('#fileMeta').textContent = `${sorted.length} phần · ${humanDuration(state.duration)} · ${bytes(totalBytes)} · đã lưu an toàn`;
  $('#audioPlayer').src = state.playback[0].url; $('#resultAudio').src = state.playback[0].url; state.playbackIndex = 0;
  if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = ''; }
  $('#dropzone').hidden = true; $('#fileCard').hidden = false; $('#startButton').disabled = false;
}

// ---------- Phát lại nhiều phần ----------
function playSegment(audioEl, index, time = 0, autoplay = true) {
  state.playbackIndex = index;
  audioEl.src = state.playback[index].url;
  audioEl.currentTime = Math.max(0, time);
  if (autoplay) audioEl.play().catch(() => {});
}
function seekPlayback(audioEl, globalSeconds) {
  if (!state.playback || state.playback.length < 2) { audioEl.currentTime = Math.max(0, globalSeconds); audioEl.play().catch(() => {}); return; }
  let index = 0;
  for (let i = 0; i < state.playback.length; i += 1) if (globalSeconds >= state.playback[i].offset) index = i;
  playSegment(audioEl, index, globalSeconds - state.playback[index].offset);
}
function attachPlaylist(audioEl) {
  audioEl.addEventListener('ended', () => {
    if (state.playback && state.playbackIndex + 1 < state.playback.length) playSegment(audioEl, state.playbackIndex + 1, 0);
  });
}

// ---------- Kết quả ----------
const LLM_RATES = { 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.4-nano': [0.2, 1.25], 'gpt-5-mini': [0.25, 2] };
const CLAUDE_RATES = { 'claude-sonnet-5': [3, 15], 'claude-haiku-4-5': [1, 5], 'claude-opus-4-8': [5, 25] };
const USD_VND = 26500;
function costEstimate() {
  if (currentEngine() === 'enterprise') {
    const usd = state.usage?.usd || 0;
    if (!usd) return '';
    const vnd = Math.max(500, Math.round(usd * USD_VND / 500) * 500);
    return ` · phân tích ~${vnd.toLocaleString('vi-VN')} đ (chưa gồm phiên âm)`;
  }
  if (!state.duration) return '';
  let sttUsd, rate;
  if (currentEngine() === 'gemini-claude') {
    sttUsd = (state.duration / 3600) * 0.09; // Gemini Flash: audio vào + transcript ra
    rate = CLAUDE_RATES[$('#claudeModelSelect').value] || CLAUDE_RATES['claude-sonnet-5'];
  } else {
    sttUsd = (state.duration / 60) * 0.006;
    rate = LLM_RATES[$('#summaryModelSelect').value] || LLM_RATES['gpt-5.4-mini'];
  }
  const llmUsd = state.usage ? ((state.usage.inputTokens || 0) * rate[0] + (state.usage.outputTokens || 0) * rate[1]) / 1e6 : 0;
  const vnd = Math.max(500, Math.round((sttUsd + llmUsd) * USD_VND / 500) * 500);
  return ` · chi phí ~${vnd.toLocaleString('vi-VN')} đ (ước tính)`;
}

// ============ Enterprise V3 UI ============
function refreshGate(analysisFallback = false) {
  if (currentEngine() === 'enterprise' && state.humanReview) {
    // Backend là nguồn quyết định; hai cổng client + officialExportAllowed
    const unresolvedVq = state.verificationQueue.filter(item => !item.resolved).length;
    const warnings = [...(state.humanReview.releaseBlockedReasons || [])];
    if (!state.gateAnomaly) warnings.push('Cổng 1: chưa xác nhận đã review điểm bất thường/dữ kiện nhạy cảm.');
    if (!state.gateFull) warnings.push('Cổng 2: chưa xác nhận đã review tổng thể biên bản.');
    if (unresolvedVq) warnings.push(`${unresolvedVq} mục trong hàng chờ xác minh chưa xử lý.`);
    const releasable = state.gateAnomaly && state.gateFull && unresolvedVq === 0 && Boolean($('#approverName')?.value.trim());
    state.gate = { releasable, warnings, unresolvedCount: unresolvedVq };
    return;
  }
  if (!state.metrics) { state.gate = null; return; }
  state.gate = computeGate(state.metrics, state.verificationQueue, state.notes, {
    thresholds: state.rules?.thresholds || {},
    analysisFallback,
    transcriptEmpty: !state.transcript.length,
  });
}

function qualityCardHtml() {
  if (!state.metrics || !state.gate) return '';
  const m = state.metrics;
  const bar = (label, value, warnAt) => {
    const percent = Math.round(value * 100);
    return `<div class="q-row"><span>${label}</span><div class="q-bar"><i style="width:${Math.min(100, percent)}%" class="${value < warnAt ? 'q-bad' : 'q-good'}"></i></div><b>${percent}%</b></div>`;
  };
  return `<div class="gate-card ${state.gate.releasable ? 'gate-ok' : 'gate-block'}">
    <div class="gate-head"><b>${state.gate.releasable ? '✅ Đủ điều kiện phát hành' : '⛔ Chưa đủ điều kiện phát hành'}</b><span>${state.verificationQueue.filter(item => !item.resolved).length} mục chờ xác minh</span></div>
    ${bar('Audio coverage', m.audioCoverage, 0.98)}
    ${bar('Speaker coverage', m.speakerCoverage, 0.9)}
    ${bar('Tỷ lệ bất thường', 1 - Math.min(1, m.anomalyRate), 0.97)}
    <div class="q-meta">${m.anomalySegments} segment cách ly · ${m.anomalySeconds}s · ${m.gaps.length} khoảng trống</div>
    ${state.gate.warnings.length ? `<details${state.gate.releasable ? '' : ' open'}><summary>${state.gate.warnings.length} cảnh báo</summary><ul>${state.gate.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

const STATUS_LABELS = { quarantined: '🔒 cách ly', rescue_pending: '⏳ chờ cứu hộ', rescued_supported: '🛟 đã cứu', human_review_required: '⚠ cần nghe lại', verified: '✓ đã xác minh', rejected: '✕ đã loại' };

function evidenceOf(item) { return Array.isArray(item?.evidence) ? item.evidence : []; }
function chipRow(times) {
  return times.length ? `<span class="evidence-list">${times.map(time => { const row = state.transcript.find(entry => entry.time === time); return `<button class="evidence-chip" type="button" data-seconds="${row?.start ?? secondsFromTime(time)}">▶ ${escapeHtml(time)}</button>`; }).join('')}</span>` : '<span class="confidence-note">Chưa có mốc bằng chứng</span>';
}

function renderTimeline() {
  const items = state.v3?.topicTimeline || [];
  $('#timelinePanel').innerHTML = `<div class="section-label">Timeline chủ đề</div>` + (items.length
    ? `<div class="timeline">${items.map(item => `<div class="tl-item"><button class="timestamp" type="button" data-seconds="${secondsFromTime(item.startTime)}">${escapeHtml(item.startTime || '')}–${escapeHtml(item.endTime || '')}</button><div><b>${escapeHtml(item.topic || '')}</b><p>${escapeHtml(item.summary || '')}</p></div></div>`).join('')}</div>`
    : '<p class="empty-note">Chưa có dữ liệu timeline (cần engine Backend).</p>');
}

function renderConflicts() {
  const conflicts = state.v3?.conflicts || [];
  $('#conflictsPanel').innerHTML = `<div class="section-label">Phát biểu / số liệu mâu thuẫn</div>` + (conflicts.length
    ? conflicts.map(conflict => `<div class="conflict-card"><b>${escapeHtml(conflict.topic || 'Mâu thuẫn')}</b>
        <div class="conflict-pair"><div><span class="conflict-tag">Phiên bản A</span><p>${escapeHtml(conflict.versionA?.text || '')}</p>${chipRow(evidenceOf(conflict.versionA))}</div>
        <div><span class="conflict-tag">Phiên bản B</span><p>${escapeHtml(conflict.versionB?.text || '')}</p>${chipRow(evidenceOf(conflict.versionB))}</div></div></div>`).join('')
    : '<p class="empty-note">Không phát hiện mâu thuẫn, hoặc chưa chạy engine Backend.</p>');
}

function renderRisksIssues() {
  const v3 = state.v3 || {};
  const section = (title, items, renderer) => (items?.length ? `<div class="section-label section-space">${title}</div><ul class="notes-list evidence-notes">${items.map(renderer).join('')}</ul>` : '');
  const simple = item => `<li><span>${escapeHtml(item.text || item.rawText || '')}</span>${chipRow(evidenceOf(item))}</li>`;
  $('#risksPanel').innerHTML =
    `<div class="section-label">Rủi ro</div>` +
    ((state.notes?.risks || []).length ? `<ul class="notes-list evidence-notes">${(state.notes.risks).map(item => `<li><span>${escapeHtml(factText(item))}${item.impact ? ` — tác động: ${escapeHtml(item.impact)}` : ''}</span>${chipRow(evidenceOf(item))}</li>`).join('')}</ul>` : '<p class="empty-note">Chưa ghi nhận rủi ro.</p>') +
    section('Câu hỏi mở', v3.openQuestions, simple) +
    section('Chờ phê duyệt', v3.pendingApprovals, item => `<li><span>${escapeHtml(item.text || '')}${item.approver ? ` — chờ: ${escapeHtml(item.approver)}` : ''}</span>${chipRow(evidenceOf(item))}</li>`) +
    section('Trạng thái theo khu / hạng mục', v3.projectStatus, item => `<li><span><b>${escapeHtml(item.area || '')}</b>: ${escapeHtml(item.status || '')}</span>${chipRow(evidenceOf(item))}</li>`) +
    section('Số liệu thương mại / tài chính (cần xác minh trước khi dùng)', v3.commercialFinancial, item => `<li><span>${escapeHtml(item.rawText || '')}${item.normalizedValue ? ` → ${escapeHtml(String(item.normalizedValue))} ${escapeHtml(item.unit || '')}` : ''} ${item.verified ? '✓' : '⚠ chưa xác minh'}</span>${chipRow(evidenceOf(item))}</li>`);
}

function renderVerify() {
  const queue = state.verificationQueue;
  const groups = [...new Set(queue.map(item => item.group))];
  const pending = queue.filter(item => !item.resolved).length;
  let html = `<div class="section-label">Hàng chờ xác minh (${pending} chưa xử lý)</div>`;
  if (!queue.length) html += '<p class="empty-note">Không có mục cần xác minh (hoặc dữ liệu cũ chưa có guardrails).</p>';
  for (const group of groups) {
    const items = queue.filter(item => item.group === group);
    html += `<details class="vq-group" ${items.some(item => !item.resolved) ? 'open' : ''}><summary>${escapeHtml(group)} <span>${items.filter(item => !item.resolved).length}/${items.length}</span></summary>${items.map(item => `
      <div class="vq-item ${item.resolved ? 'vq-done' : ''}" data-vq="${item.id}">
        <div class="vq-body">
          <p>${escapeHtml(item.description || item.originalText || '')}</p>
          ${item.kind === 'backend_vq' ? `<p class="vq-suggest">${item.priority ? `Ưu tiên ${escapeHtml(item.priority)} · ` : ''}${escapeHtml(item.backendType || '')} · trạng thái: <b>${escapeHtml(item.status)}</b>${item.rescue ? `<br>Cứu hộ: <b>${escapeHtml(item.rescue.text || item.rescue.reason || '')}</b> (vẫn cần nghe lại)` : ''}</p>` : ''}
          ${item.kind === 'normalize' ? `<p class="vq-suggest">Gợi ý: <b>${escapeHtml(item.normalizedText)}</b> <small>(${escapeHtml(item.reason)})</small></p>` : ''}
          ${item.kind === 'anomaly' ? `<p class="vq-suggest">${STATUS_LABELS[item.status] || item.status}${item.rescue?.reason ? ` — ${escapeHtml(item.rescue.reason)}` : ''}${item.rescue?.supportedText ? `<br>Bản cứu hộ: <b>${escapeHtml(item.rescue.supportedText)}</b>` : ''}</p>` : ''}
          ${typeof item.confidence === 'number' ? `<p class="vq-suggest">Confidence: ${item.confidence.toFixed(2)}</p>` : ''}
        </div>
        <div class="vq-actions">
          <button class="pill-button" data-vq-act="listen" type="button">▶ Nghe</button>
          ${item.kind === 'backend_vq' ? '<button class="pill-button" data-vq-act="rescue" type="button">🛟 Cứu hộ</button>' : ''}
          <button class="pill-button" data-vq-act="confirm" type="button">✓ Xác nhận</button>
          ${item.kind === 'backend_vq' ? '<button class="pill-button" data-vq-act="reject" type="button">✕ Từ chối</button>' : '<button class="pill-button" data-vq-act="edit" type="button">✎ Sửa</button>'}
          <button class="pill-button" data-vq-act="skip" type="button">Bỏ qua</button>
        </div>
      </div>`).join('')}</details>`;
  }
  // Diff raw / normalized
  const diffs = state.normalizationLog;
  html += `<div class="section-label section-space">Raw ↔ Normalized (${diffs.length} thay đổi có kiểm soát)</div>`;
  html += diffs.length
    ? `<div class="diff-list">${diffs.map(log => `<div class="diff-row"><button class="timestamp" type="button" data-seconds="${log.start || 0}">${escapeHtml(formatClockApp(log.start || 0))}</button><div><del>${escapeHtml(log.originalText)}</del> → <ins>${escapeHtml(log.normalizedText)}</ins><small>${escapeHtml(log.reason)} · ${escapeHtml(log.source)}</small></div></div>`).join('')}</div>`
    : '<p class="empty-note">Chưa có chỉnh sửa nào — raw transcript được giữ nguyên vẹn.</p>';
  if (state.blockedItems.length) {
    html += `<div class="section-label section-space">Bị chặn khỏi biên bản (tham chiếu đoạn chưa xác minh)</div><ul class="notes-list">${state.blockedItems.map(item => `<li>${escapeHtml(item.kind)}: ${escapeHtml(factText(item))}</li>`).join('')}</ul>`;
  }
  $('#verifyPanel').innerHTML = html;
  const badge = $('.tab[data-tab="verify"]');
  if (badge) badge.textContent = pending ? `Xác minh (${pending})` : 'Xác minh';
}

function formatClockApp(seconds) { return clock(seconds); }

async function handleVerifyAction(itemId, action) {
  const item = state.verificationQueue.find(entry => entry.id === itemId);
  if (!item) return;
  // Mục backend_vq: xác minh phía người dùng, có cứu hộ /rescue
  if (item.kind === 'backend_vq') {
    const seconds = parseEvidenceSeconds(item.evidence);
    if (action === 'listen') { seekPlayback($('#resultAudio'), Math.max(0, seconds - 3)); return; }
    if (action === 'rescue') { await runRescue(item, seconds); return; }
    if (action === 'confirm') item.status = 'confirmed';
    if (action === 'reject') item.status = 'rejected';
    if (action === 'skip') item.status = 'accepted_with_note';
    item.resolved = ['confirmed', 'rejected', 'accepted_with_note', 'corrected'].includes(item.status);
    afterVerifyChange();
    return;
  }
  const segment = state.transcript[item.index];
  if (action === 'listen') { seekPlayback($('#resultAudio'), Math.max(0, (item.start || 0) - 3)); return; }
  if (action === 'confirm') {
    if (item.kind === 'normalize' && segment) {
      state.normalizationLog.push({ originalText: item.originalText, normalizedText: item.normalizedText, reason: item.reason, confidence: item.confidence, source: item.source, start: item.start, index: item.index, at: new Date().toISOString() });
      segment.text = segment.text.split(item.originalText).join(item.normalizedText);
    }
    if (item.kind === 'anomaly' && segment) {
      if (segment.rescue?.supportedText && segment.status !== 'rescued_supported') {
        state.normalizationLog.push({ originalText: segment.text, normalizedText: segment.rescue.supportedText, reason: 'Người dùng chấp nhận bản cứu hộ', confidence: 'high', source: 'human_review', start: segment.start, index: item.index, at: new Date().toISOString() });
        segment.text = segment.rescue.supportedText;
      }
      segment.status = 'verified';
    }
    if (item.kind === 'speaker' && segment) { const name = prompt('Tên người nói cho đoạn này:', segment.speaker || 'Người nói 1'); if (name) segment.speaker = name; }
    item.resolved = true;
  }
  if (action === 'edit' && segment) {
    const edited = prompt('Sửa nội dung đoạn này (raw transcript vẫn được giữ nguyên):', segment.text);
    if (edited !== null && edited !== segment.text) {
      state.normalizationLog.push({ originalText: segment.text, normalizedText: edited, reason: 'Người dùng sửa tay sau khi nghe lại', confidence: 'high', source: 'human_review', start: segment.start, index: item.index, at: new Date().toISOString() });
      segment.text = edited;
      if (item.kind === 'anomaly') segment.status = 'verified';
    }
    item.resolved = true;
  }
  if (action === 'skip') item.resolved = true;
  afterVerifyChange();
}

function afterVerifyChange() {
  // Bất kỳ chỉnh sửa nào sau phê duyệt → cần duyệt lại
  if (state.approved) { state.approved = false; state.documentStatus = 'reapproval_required'; state.gateFull = false; }
  refreshGate(false);
  renderVerify();
  renderTranscript($('#transcriptSearch')?.value || '');
  const summaryGate = $('#gateSlot'); if (summaryGate) summaryGate.innerHTML = qualityCardHtml();
  renderDraftState();
  saveHistory();
}

// Cứu hộ đoạn nghi ngờ qua /rescue (16_ARCHITECTURE: không ghi đè raw, cho người dùng so sánh)
async function runRescue(item, seconds) {
  if (!state.file || !(state.file instanceof Blob)) { showError('Không còn audio gốc để cứu hộ.', 'Cứu hộ chỉ chạy được trong phiên vừa phân tích, khi file còn trong trình duyệt.'); return; }
  try {
    setProgress(0, '', '', 3);
    const padded = await sliceAudioWindow(state.file, Math.max(0, seconds - 5), seconds + 25);
    if (!padded) { showError('Không cắt được đoạn audio này.'); return; }
    const data = await rescueSegment(padded, Math.max(0, seconds - 5));
    const text = (data?.transcript || []).map(row => row.text).join(' ').trim() || data?.text || '';
    item.rescue = { text, reason: data?.rescueStatus || 'human_review_required', raw: data };
    // KHÔNG ghi đè raw transcript — chỉ hiển thị để so sánh
    renderVerify();
    showError('Kết quả cứu hộ (chưa áp dụng tự động):', text || 'Không phục hồi được nội dung — cần nghe lại thủ công.');
  } catch (error) { showError('Cứu hộ thất bại.', error.message); }
}

// Cắt cửa sổ audio → WAV mono 16kHz để gửi /rescue
async function sliceAudioWindow(fileBlob, startSec, endSec) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await fileBlob.arrayBuffer());
    const rate = 16000;
    const OfflineClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const from = Math.max(0, Math.floor(startSec * buffer.sampleRate));
    const to = Math.min(buffer.length, Math.ceil(endSec * buffer.sampleRate));
    if (to - from < buffer.sampleRate) return null;
    const src = buffer.getChannelData(0).slice(from, to);
    const offline = new OfflineClass(1, Math.ceil(src.length / buffer.sampleRate * rate), rate);
    const node = offline.createBufferSource();
    const tmp = offline.createBuffer(1, src.length, buffer.sampleRate);
    tmp.copyToChannel(src, 0);
    node.buffer = tmp; node.connect(offline.destination); node.start();
    const rendered = await offline.startRendering();
    return wavBlobMain(rendered.getChannelData(0).slice());
  } catch { return null; } finally { await context.close().catch(() => {}); }
}

function renderResults() {
  const notes = state.notes || {}; const title = notes.title && notes.title !== 'Chưa xác định' ? notes.title : (state.file?.name || 'Cuộc họp').replace(/\.[^.]+$/, '');
  $('#meetingTitle').value = title;
  if (!state.playback && state.audioUrl) $('#resultAudio').src = state.audioUrl;
  const elapsed = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)); $('#meetingMeta').textContent = `${new Date().toLocaleString('vi-VN')} · ${humanDuration(state.duration)} · xử lý trong ${elapsed} giây${costEstimate()}`;
  $('#wordCount').textContent = state.transcript.reduce((n, row) => n + row.text.split(/\s+/).filter(Boolean).length, 0).toLocaleString('vi-VN'); $('#decisionCount').textContent = (notes.decisions || []).length; $('#actionCount').textContent = (notes.actions || []).length;
  const coverage = notes.coverage || {}; const warnings = coverage.warnings || [];
  const coveragePanel = coverage.totalChunks ? `<div class="coverage-card"><div><b>${coverage.percent || 0}% transcript đã phân tích</b><span>${coverage.processedChunks}/${coverage.totalChunks} phần · ${coverage.lowConfidence || 0} kết luận cần kiểm tra</span></div><span class="coverage-badge">FULL PASS</span>${warnings.length ? `<details open><summary>${warnings.length} cảnh báo</summary><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}</div>` : '';
  const execTitle = state.v3?.selectedTemplate?.id ? `<div class="tpl-badge">Mẫu: ${escapeHtml(state.v3.selectedTemplate.id)}${state.v3.selectedTemplate.confidence ? ` (${Math.round(state.v3.selectedTemplate.confidence * 100)}%)` : ''}</div>` : '';
  $('#summaryPanel').innerHTML = `<div id="gateSlot">${qualityCardHtml()}</div>${coveragePanel}${execTitle}<div class="section-label">Tóm tắt điều hành</div><p class="summary-text">${escapeHtml(notes.summary || 'Chưa có tóm tắt.')}</p><div class="section-label">Điểm chính</div><ul class="notes-list evidence-notes">${(notes.keyPoints || []).map(point => `<li><span>${escapeHtml(factText(point))}</span>${evidenceHtml(point)}</li>`).join('') || '<li>Chưa xác định.</li>'}</ul>${(notes.risks || []).length ? `<div class="section-label section-space">Rủi ro &amp; vướng mắc</div><ul class="notes-list evidence-notes">${notes.risks.map(item => `<li><span>${escapeHtml(factText(item))}</span>${evidenceHtml(item)}</li>`).join('')}</ul>` : ''}${state.images.length ? `<div class="section-label section-space">Tài liệu tham chiếu</div><ul class="notes-list">${state.images.map(file => `<li>Ảnh: ${escapeHtml(file.name)}</li>`).join('')}</ul>` : ''}`;
  renderTranscript();
  $('#decisionsPanel').innerHTML = `<div class="section-label">Các quyết định đã ghi nhận</div><div class="decision-list">${(notes.decisions || []).map((item, i) => `<div class="decision-item${item.confidence === 'low' ? ' low-confidence' : ''}"><b>${String(i + 1).padStart(2, '0')}. ${escapeHtml(factText(item))}</b>${item.context ? `<small>${escapeHtml(item.context)}</small>` : ''}${item.evidenceStatus ? `<span class="ev-tag ev-${escapeHtml(item.evidenceStatus)}">${escapeHtml(item.evidenceStatus)}</span>` : ''}${evidenceHtml(item)}</div>`).join('') || '<p>Chưa ghi nhận quyết định rõ ràng.</p>'}</div>`;
  $('#actionsPanel').innerHTML = `<div class="section-label">Danh sách việc cần làm</div><div class="action-list">${(notes.actions || []).map(item => `<div class="action-item${item.confidence === 'low' ? ' low-confidence' : ''}"><input type="checkbox" aria-label="Đánh dấu hoàn thành"><span><span class="owner">${escapeHtml(item.owner || 'Chưa xác định')}</span><span class="action-text">${escapeHtml(factText(item))}</span>${item.due && item.due !== 'Chưa xác định' ? '' : ''}${evidenceHtml(item)}</span><span class="due">${escapeHtml(item.due || 'Chưa xác định')}</span></div>`).join('') || '<p>Chưa ghi nhận đầu việc rõ ràng.</p>'}</div>`;
  renderTimeline(); renderConflicts(); renderRisksIssues(); renderVerify();
  renderMindMap(); renderAskHistory(); updateHighlightCount(); renderDraftState(); saveHistory(); showView('results');
}

// Trạng thái bản nháp / phê duyệt (engine enterprise). Engine khác: ẩn banner + card duyệt.
function renderDraftState() {
  const isEnterprise = currentEngine() === 'enterprise' && state.documentStatus;
  $('#draftBanner').hidden = !isEnterprise;
  $('#approvalCard').hidden = !isEnterprise;
  $('#approveButton').hidden = !isEnterprise;
  $('#exportButton').textContent = isEnterprise ? (state.approved ? 'Xuất chính thức' : 'Xuất bản nháp') : 'Chia sẻ & xuất';
  if (!isEnterprise) return;
  const label = state.approved ? '✅ ĐÃ PHÊ DUYỆT'
    : state.documentStatus === 'reapproval_required' ? '♻ CẦN DUYỆT LẠI'
    : 'BẢN NHÁP AI — CHƯA PHÊ DUYỆT';
  $('#draftStatusLabel').textContent = label;
  $('#draftBanner').classList.toggle('approved', state.approved);
  $('#draftStatusHint').textContent = state.approved
    ? `Người duyệt: ${state.approvedBy || ''} · ${state.approvedAt || ''}`
    : (state.gate?.warnings?.[0] || 'Xử lý hàng chờ xác minh và tick 2 cổng duyệt để mở xuất chính thức.');
  $('#gateAnomaly').checked = state.gateAnomaly;
  $('#gateFull').checked = state.gateFull;
  const anomTotal = state.humanReview?.anomalyTotalCount ?? state.verificationQueue.length;
  $('#gateAnomalyState').textContent = `${state.verificationQueue.filter(i => i.resolved).length}/${state.verificationQueue.length} mục · ${anomTotal} anomaly`;
  refreshGate(false);
  $('#approveButton').disabled = !state.gate?.releasable || state.approved;
}

function renderTranscript(query = '') {
  const term = query.trim().toLocaleLowerCase('vi');
  const rows = state.transcript.map((row, i) => {
    let text = escapeHtml(row.text); if (term && row.text.toLocaleLowerCase('vi').includes(term)) text = text.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu'), '<mark>$1</mark>');
    const highlighted = state.highlights.some(item => Math.abs(item.time - row.start) < 8);
    const anomalous = row.status && row.status !== 'raw' && row.status !== 'verified';
    const badge = anomalous ? `<span class="anom-badge">${STATUS_LABELS[row.status] || row.status}</span>` : '';
    return `<article class="transcript-row${highlighted ? ' highlight-row' : ''}${anomalous ? ' anomalous-row' : ''}"><button class="timestamp" type="button" data-seconds="${Number(row.start) || 0}">${escapeHtml(row.time)} ▶</button><input class="speaker-input" data-speaker-index="${i}" value="${escapeHtml(row.speaker || 'Người nói 1')}" aria-label="Tên người nói"><p>${text}${badge}</p></article>`;
  }).join('');
  const rawCount = state.rawTranscript.length;
  $('#transcriptPanel').innerHTML = `<div class="transcript-tools"><input id="transcriptSearch" placeholder="Tìm trong transcript…" value="${escapeHtml(query)}"><span>${state.transcript.length} đoạn${rawCount ? ` · raw ${rawCount}` : ''}</span></div>${rows}`;
  $('#transcriptSearch').addEventListener('input', event => renderTranscript(event.target.value));
}

function renderMindMapBranches() {
  const notes = state.notes || {};
  const backendMap = state.v3?.mindMap;
  const branch = (title, items) => `<section class="mind-branch"><strong>${escapeHtml(title)}</strong><ul>${(items || []).map(item => `<li>${escapeHtml(item.text || item)}</li>`).join('') || '<li>Chưa có dữ liệu</li>'}</ul></section>`;
  if (backendMap && typeof backendMap === 'object' && Array.isArray(backendMap.branches)) {
    // Backend trả mindMap {root, branches:[{label, items:[]}]}
    $('#mindmapPanel').innerHTML = `<div class="mindmap"><div class="mind-root">${escapeHtml(backendMap.root || $('#meetingTitle').value || notes.title)}</div><div class="mind-branches">${backendMap.branches.map(b => branch(b.label || '', b.items)).join('')}</div></div>`;
    return;
  }
  $('#mindmapPanel').innerHTML = `<div class="mindmap"><div class="mind-root">${escapeHtml($('#meetingTitle').value || notes.title)}</div><div class="mind-branches">${branch('Điểm chính', notes.keyPoints)}${branch('Quyết định', notes.decisions)}${branch('Hành động', notes.actions)}</div></div>`;
}
async function renderMindMap() {
  const code = String(state.notes?.mindmap || '').trim();
  if (!code || !/^mindmap/u.test(code)) { renderMindMapBranches(); return; }
  $('#mindmapPanel').innerHTML = '<div class="mermaid-wrap" id="mermaidWrap">Đang vẽ sơ đồ…</div>';
  try {
    if (!window.__mermaid) {
      const module = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
      window.__mermaid = module.default;
      window.__mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
    }
    const { svg } = await window.__mermaid.render(`mmGraph${Date.now()}`, code);
    const wrap = $('#mermaidWrap');
    if (wrap) wrap.innerHTML = svg;
  } catch (error) {
    console.warn('Mermaid render:', error);
    renderMindMapBranches();
  }
}

function renderAskHistory() {
  $('#askHistory').innerHTML = state.askHistory.map(item => `<div class="ask-bubble ${item.role === 'question' ? 'question' : 'answer'}">${escapeHtml(item.text)}${item.references?.length ? `<small>Tham chiếu: ${item.references.map(clock).join(', ')}</small>` : ''}</div>`).join('');
}

function updateHighlightCount() { $('#highlightCount').textContent = `${state.highlights.length} highlights`; }

function addHighlight() {
  const player = $('#resultAudio');
  const base = state.playback && state.playback.length > 1 ? state.playback[state.playbackIndex]?.offset || 0 : 0;
  const time = base + (player.currentTime || 0); const note = prompt(`Ghi chú tại ${clock(time)}:`, '') ?? '';
  state.highlights.push({ time, note, createdAt: Date.now() }); updateHighlightCount(); renderTranscript($('#transcriptSearch')?.value || ''); saveHistory();
}

// ---------- Xuất ----------
function markdown() {
  const n = state.notes || {};
  const refs = item => item?.evidence?.length ? ` [${item.evidence.join(', ')}]` : '';
  return `# ${$('#meetingTitle').value}\n\n- Thời gian: ${new Date().toLocaleString('vi-VN')}\n- Thời lượng: ${humanDuration(state.duration)}\n- Mẫu: ${$('#templateSelect').value}\n\n## Tóm tắt\n\n${n.summary || ''}\n\n## Điểm chính\n\n${(n.keyPoints || []).map(x => `- ${factText(x)}${refs(x)}`).join('\n')}\n\n## Quyết định\n\n${(n.decisions || []).map((x, i) => `${i + 1}. ${factText(x)}${x.context ? ` — ${x.context}` : ''}${refs(x)}`).join('\n')}\n\n## Việc cần làm\n\n${(n.actions || []).map(x => `- [ ] ${factText(x)} — ${x.owner || 'Chưa xác định'} — ${x.due || 'Chưa xác định'}${refs(x)}`).join('\n')}\n\n## Rủi ro\n\n${(n.risks || []).map(x => `- ${factText(x)}${refs(x)}`).join('\n')}\n\n## Highlights\n\n${state.highlights.map(x => `- ${clock(x.time)} — ${x.note || 'Đã đánh dấu'}`).join('\n')}\n\n## Transcript\n\n${state.transcript.map(x => `**${x.time} — ${x.speaker || 'Người nói'}:** ${x.text}`).join('\n\n')}\n`;
}

function srtTime(seconds) { const n = Math.max(0, Number(seconds) || 0), h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = Math.floor(n % 60), ms = Math.floor((n % 1) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }
function srt() { return state.transcript.map((x, i) => `${i + 1}\n${srtTime(x.start)} --> ${srtTime(x.end > x.start ? x.end : x.start + 3)}\n${x.speaker || 'Người nói'}: ${x.text}\n`).join('\n'); }
function projectData() { return { version: 3, title: $('#meetingTitle').value, date: new Date().toISOString(), duration: state.duration, engine: currentEngine(), organization: state.organization, transcript: state.transcript, rawTranscript: state.rawTranscript, notes: state.notes, v3: state.v3, metrics: state.metrics, verificationQueue: state.verificationQueue, normalizationLog: state.normalizationLog, highlights: state.highlights, askHistory: state.askHistory, context: generationContext(), documentStatus: state.documentStatus, humanReview: state.humanReview, speakerMap: state.speakerMap, gateAnomaly: state.gateAnomaly, gateFull: state.gateFull, approved: state.approved, approvedBy: state.approvedBy, approvedAt: state.approvedAt, approvalNote: state.approvalNote, officialExportAllowed: state.officialExportAllowed }; }

function downloadFile(extension, content, type = 'text/plain') { const blob = new Blob([content], { type: `${type};charset=utf-8` }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${($('#meetingTitle').value || 'bien-ban').replace(/[\\/:*?"<>|]/g, '-')}.${extension}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 500); return blob; }

function fileBase() { return ($('#meetingTitle').value || 'bien-ban').replace(/[\\/:*?"<>|]/g, '-'); }
function reportMeta(mode) { return `${new Date().toLocaleString('vi-VN')} · ${humanDuration(state.duration)} · chế độ ${mode}${state.v3?.selectedTemplate?.id ? ' · mẫu ' + state.v3.selectedTemplate.id : ''}`; }
function currentMode() { return $('#exportMode')?.value || 'full'; }
function reportBlocks() {
  const mode = currentMode();
  const notes = state.notes || {};
  const shareable = mode === 'shareable';
  const notesForExport = shareable ? { ...notes } : notes;
  const v3 = shareable && state.v3 ? { ...state.v3, confidentialNotes: [] } : state.v3;
  const blocks = buildReportBlocks({
    title: $('#meetingTitle').value,
    meta: reportMeta(mode === 'executive' ? 'Executive Brief' : mode === 'shareable' ? 'Shareable' : 'Full Minutes'),
    notes: notesForExport, v3,
    transcript: mode === 'full' ? state.transcript : null,
    metrics: mode === 'executive' ? null : state.metrics,
    gate: state.gate,
    includeTranscript: mode === 'full',
  });
  // Watermark bản nháp / metadata bản chính thức (16_ARCHITECTURE quy tắc xuất)
  if (currentEngine() === 'enterprise') {
    if (state.approved) {
      blocks.splice(1, 0, { type: 'meta', text: `BẢN CHÍNH THỨC · người duyệt: ${state.approvedBy || ''} · duyệt lúc: ${state.approvedAt || ''} · phiên bản: ${state.currentId ? state.currentId.slice(0, 8) : '—'}${state.approvalNote ? ` · ghi chú: ${state.approvalNote}` : ''}` });
    } else {
      blocks.unshift({ type: 'h1', text: '⚠ BẢN NHÁP AI — CHƯA PHÊ DUYỆT' });
    }
  }
  return blocks;
}

async function exportAs(type) {
  const base = fileBase();
  if (type === 'md') downloadFile('md', markdown(), 'text/markdown');
  if (type === 'txt') downloadFile('txt', markdown().replace(/[#*_`]/g, ''));
  if (type === 'srt') downloadFile('srt', srt(), 'application/x-subrip');
  if (type === 'json') downloadFile('json', JSON.stringify(projectData(), null, 2), 'application/json');
  if (type === 'docx') exportDocx(base, reportBlocks());
  if (type === 'pdf') { exportPdf(base, reportBlocks()); $('#exportDialog').close(); return; }
  if (type === 'csv') {
    const rows = [['Loại', 'Nội dung', 'Owner', 'Deadline', 'Ưu tiên', 'Evidence', 'Confidence']];
    (state.notes?.actions || []).forEach(item => rows.push(['Action', factText(item), item.owner || 'Chưa xác định', item.due || 'Chưa xác định', item.priority || '', (item.evidence || []).join(' '), item.confidence || '']));
    (state.notes?.risks || []).forEach(item => rows.push(['Risk', factText(item), item.owner || '', '', '', (item.evidence || []).join(' '), item.confidence || '']));
    exportCsv(base, rows);
  }
  if (type === 'svg') { const svg = $('#mindmapPanel svg'); if (!exportSvg(base, svg)) showError('Chưa có sơ đồ Mermaid để xuất SVG.', 'Mở tab Mind map trước, hoặc dùng engine tạo được mã Mermaid.'); }
  if (type === 'share') {
    const file = new File([markdown()], `${base}.md`, { type: 'text/markdown' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: $('#meetingTitle').value, files: [file] }); else downloadFile('md', markdown(), 'text/markdown');
  }
  $('#exportDialog').close();
}

// ---------- Thư viện ----------
function getHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory() {
  const item = projectData(); item.id = state.currentId || crypto.randomUUID(); state.currentId = item.id;
  let history = [item, ...getHistory().filter(x => x.id !== item.id)].slice(0, 12);
  while (history.length) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); break; }
    catch { if (history.length === 1) { console.warn('Biên bản quá lớn, không lưu được vào thư viện.'); break; } history = history.slice(0, Math.ceil(history.length / 2)); }
  }
  updateLibrary();
}
function updateLibrary() { const history = getHistory(); $('#libraryCount').textContent = history.length; $('#libraryList').innerHTML = history.length ? history.map(item => `<div class="library-item"><div><b>${escapeHtml(item.title || 'Biên bản')}</b><small>${new Date(item.date).toLocaleString('vi-VN')} · ${humanDuration(item.duration)}</small></div><button data-load-id="${item.id}">Mở</button><button class="delete" data-delete-id="${item.id}">Xóa</button></div>`).join('') : '<div class="library-empty">Chưa có biên bản trên thiết bị này.</div>'; }
function loadProject(item) {
  state.currentId = item.id || crypto.randomUUID(); state.file = { name: item.title || 'Biên bản đã lưu' }; state.duration = item.duration || 0;
  state.transcript = item.transcript || []; state.notes = item.notes || {}; state.highlights = item.highlights || []; state.askHistory = item.askHistory || [];
  // Enterprise V3 fields (tương thích ngược — dữ liệu cũ để rỗng)
  state.rawTranscript = item.rawTranscript || []; state.v3 = item.v3 || null; state.metrics = item.metrics || null;
  state.verificationQueue = item.verificationQueue || []; state.normalizationLog = item.normalizationLog || []; state.blockedItems = [];
  // Enterprise V3.1
  state.organization = item.organization && ORGANIZATIONS.includes(item.organization) ? item.organization : 'Alliance';
  state.documentStatus = item.documentStatus || ''; state.humanReview = item.humanReview || null; state.speakerMap = item.speakerMap || {}; state.backendNotes = item.v3 || null;
  state.gateAnomaly = Boolean(item.gateAnomaly); state.gateFull = Boolean(item.gateFull); state.approved = Boolean(item.approved);
  state.approvedBy = item.approvedBy || ''; state.approvedAt = item.approvedAt || ''; state.approvalNote = item.approvalNote || ''; state.officialExportAllowed = Boolean(item.officialExportAllowed);
  refreshGate(false);
  state.audioUrl = ''; clearPlayback(); state.usage = null; $('#libraryDialog').close(); state.startedAt = Date.now(); renderResults();
}

function resetApp() {
  if (state.worker) state.worker.terminate(); state.worker = null; removeFile();
  state.transcript = []; state.notes = null; state.highlights = []; state.recordMarks = []; state.askHistory = []; state.images = []; state.currentId = null; state.usage = null;
  // Enterprise
  state.pendingTranscript = []; state.speakerMap = {}; state.documentStatus = ''; state.humanReview = null; state.backendNotes = null; state.v3 = null; state.metrics = null;
  state.verificationQueue = []; state.rawTranscript = []; state.blockedItems = []; state.gateAnomaly = false; state.gateFull = false; state.approved = false; state.approvedBy = ''; state.approvedAt = ''; state.approvalNote = ''; state.gate = null;
  $('#imageInput').value = ''; $('#imageCount').textContent = 'Chưa có ảnh'; showView('landing');
}

// ---------- Gắn sự kiện ----------
$('#audioInput').addEventListener('change', event => setFile(event.target.files[0])); $('#removeFile').addEventListener('click', removeFile); $('#startButton').addEventListener('click', startAnalysis); $('#newButton').addEventListener('click', resetApp); $('#recordButton').addEventListener('click', toggleRecording);
$('#exportButton').addEventListener('click', () => $('#exportDialog').showModal()); $('#infoButton').addEventListener('click', () => $('#infoDialog').showModal()); $('#libraryButton').addEventListener('click', () => { updateLibrary(); $('#libraryDialog').showModal(); }); $('#highlightButton').addEventListener('click', addHighlight);
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close())); $$('[data-export]').forEach(button => button.addEventListener('click', () => exportAs(button.dataset.export)));
$('#imageInput').addEventListener('change', event => { state.images = [...event.target.files].slice(0, 6); $('#imageCount').textContent = state.images.length ? `${state.images.length} ảnh` : 'Chưa có ảnh'; });

$('#apiKeyInput').addEventListener('change', event => { try { localStorage.setItem(API_KEY_STORAGE, event.target.value.trim()); } catch {} updateApiStatus(); });
$('#geminiKeyInput').addEventListener('change', event => { try { localStorage.setItem(GEMINI_KEY_STORAGE, event.target.value.trim()); } catch {} updateApiStatus(); });
$('#claudeKeyInput').addEventListener('change', event => { try { localStorage.setItem(CLAUDE_KEY_STORAGE, event.target.value.trim()); } catch {} updateApiStatus(); });
$('#engineSelect').addEventListener('change', () => { saveSettings(); updateApiStatus(); });
$('#organizationSelect').addEventListener('change', event => {
  state.organization = event.target.value; saveSettings(); updateApiStatus();
  // Đổi công ty sau khi đã có kết quả → cần phân tích lại, huỷ phê duyệt (yêu cầu file 20 phần 1.5)
  if (state.backendNotes) { state.approved = false; state.documentStatus = 'reanalyze_required'; state.gateFull = false; refreshGate(false); renderDraftState();
    showError('Đã đổi công ty.', 'Biên bản hiện tại thuộc công ty trước. Bấm "＋ Mới" và phân tích lại với đúng hồ sơ công ty — không giữ biên bản cũ làm bản chính thức.'); }
});
// Màn hình xác nhận speaker
$('#confirmSpeakersButton').addEventListener('click', confirmSpeakersAndAnalyze);
$('#cancelSpeakersButton').addEventListener('click', () => { state.pendingTranscript = []; showView('landing'); });
$('#speakerList').addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button) return; const player = $('#audioPlayer'); if (state.audioUrl) { player.currentTime = Number(button.dataset.seconds) || 0; player.play().catch(() => {}); } });
// Hai cổng duyệt
$('#gateAnomaly').addEventListener('change', event => { state.gateAnomaly = event.target.checked; if (state.approved && !event.target.checked) { state.approved = false; state.documentStatus = 'reapproval_required'; } refreshGate(false); renderDraftState(); saveHistory(); });
$('#gateFull').addEventListener('change', event => { state.gateFull = event.target.checked; if (state.approved && !event.target.checked) { state.approved = false; state.documentStatus = 'reapproval_required'; } refreshGate(false); renderDraftState(); saveHistory(); });
$('#approverName').addEventListener('input', () => { refreshGate(false); renderDraftState(); });
$('#approveButton').addEventListener('click', () => {
  refreshGate(false);
  if (!state.gate?.releasable) { showError('Chưa đủ điều kiện phê duyệt.', (state.gate?.warnings || []).join(' ') || 'Hãy hoàn tất 2 cổng duyệt và xử lý hàng chờ xác minh.'); return; }
  state.approved = true; state.documentStatus = 'approved';
  state.approvedBy = $('#approverName').value.trim(); state.approvedAt = new Date().toLocaleString('vi-VN');
  state.approvalNote = $('#approvalNote').value.trim();
  renderDraftState(); saveHistory();
  showError('Đã phê duyệt.', `Người duyệt: ${state.approvedBy}. Giờ có thể xuất bản chính thức (DOCX/PDF có người duyệt, thời điểm, phiên bản).`);
});
$('#exportMode').addEventListener('change', () => { const draft = currentEngine() === 'enterprise' && !state.approved; $('#exportModeNote').textContent = draft ? 'Chưa phê duyệt: file có watermark "BẢN NHÁP AI".' : 'Đã phê duyệt: xuất bản chính thức có người duyệt + phiên bản.'; });
$('#claudeModelSelect').addEventListener('change', saveSettings);
$('#sttModelSelect').addEventListener('change', saveSettings); $('#summaryModelSelect').addEventListener('change', saveSettings);
$('#pauseButton').addEventListener('click', togglePause);
$('#markButton').addEventListener('click', addRecordMark);
$('#blackoutButton').addEventListener('click', enterBlackout);
let blackoutTapAt = 0;
$('#blackout').addEventListener('click', () => { const now = Date.now(); if (now - blackoutTapAt < 500) exitBlackout(); blackoutTapAt = now; });
$('#recoveryRestore').addEventListener('click', async () => { try { const segments = await dbAllSegments(); if (segments.length) applyRecordedSession(segments); $('#recoveryBanner').hidden = true; } catch { showError('Không đọc được bản ghi đã lưu.'); } });
$('#recoveryDelete').addEventListener('click', async () => { await dbClearSegments().catch(() => {}); $('#recoveryBanner').hidden = true; });

['dragenter', 'dragover'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.remove('drag'); if (name === 'drop') setFile(event.dataTransfer.files[0]); }));
$$('.tab').forEach(tab => tab.addEventListener('click', () => { $$('.tab').forEach(item => item.classList.toggle('active', item === tab)); $$('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === `${tab.dataset.tab}Panel`)); }));
$('#transcriptPanel').addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button || (!state.audioUrl && !state.playback)) return; seekPlayback($('#resultAudio'), Number(button.dataset.seconds) || 0); });
['summaryPanel', 'decisionsPanel', 'actionsPanel', 'timelinePanel', 'conflictsPanel', 'risksPanel', 'verifyPanel'].forEach(id => $(`#${id}`).addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button || (!state.audioUrl && !state.playback)) return; seekPlayback($('#resultAudio'), Number(button.dataset.seconds) || 0); }));
$('#verifyPanel').addEventListener('click', event => { const button = event.target.closest('[data-vq-act]'); if (!button) return; const wrap = button.closest('[data-vq]'); if (wrap) handleVerifyAction(wrap.dataset.vq, button.dataset.vqAct); });
$('#transcriptPanel').addEventListener('change', event => { const input = event.target.closest('[data-speaker-index]'); if (!input) return; state.transcript[Number(input.dataset.speakerIndex)].speaker = input.value.trim() || 'Người nói'; saveHistory(); });
$('#actionsPanel').addEventListener('change', event => { const item = event.target.closest('.action-item'); if (item) item.classList.toggle('done', event.target.checked); });
$('#meetingTitle').addEventListener('change', () => { renderMindMap(); saveHistory(); });
$('#askForm').addEventListener('submit', event => {
  event.preventDefault();
  const question = $('#askInput').value.trim(); if (!question) return;
  state.askHistory.push({ role: 'question', text: question }); renderAskHistory();
  $('#askInput').value = '';
  if (currentEngine() === 'enterprise') { askEnterpriseLocal(question); return; }
  if (missingKeys().length) { state.askHistory.push({ role: 'answer', text: `Chưa nhập API key ${missingKeys().join(' và ')}.`, references: [] }); renderAskHistory(); return; }
  $('#askInput').disabled = true; $('#askForm button').disabled = true;
  const worker = state.worker || createWorker();
  worker.postMessage({ type: 'ask', transcript: state.transcript, question, ...apiBaseMessage() });
});
// Ask AI cho enterprise: backend không có endpoint hỏi đáp → truy hồi đoạn transcript liên quan (evidence-first, không bịa)
function askEnterpriseLocal(question) {
  const words = question.toLocaleLowerCase('vi').split(/\s+/u).filter(word => word.length > 2);
  const scored = state.transcript.map(row => ({ row, score: words.reduce((sum, word) => sum + (row.text.toLocaleLowerCase('vi').includes(word) ? 1 : 0), 0) }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  const answer = scored.length
    ? 'Các đoạn liên quan trong cuộc họp (bấm mốc để nghe lại, tự kiểm chứng):\n' + scored.map(item => `[${item.row.time}] ${item.row.speaker || 'Người nói'}: ${item.row.text}`).join('\n')
    : 'Không tìm thấy trong cuộc họp.';
  state.askHistory.push({ role: 'answer', text: answer, references: scored.map(item => item.row.start || 0) });
  renderAskHistory();
}
$('#libraryList').addEventListener('click', event => { const load = event.target.closest('[data-load-id]'), del = event.target.closest('[data-delete-id]'); if (load) { const item = getHistory().find(x => x.id === load.dataset.loadId); if (item) loadProject(item); } if (del) { localStorage.setItem(HISTORY_KEY, JSON.stringify(getHistory().filter(x => x.id !== del.dataset.deleteId))); updateLibrary(); } });
$('#importInput').addEventListener('change', async event => { try { const data = JSON.parse(await event.target.files[0].text()); if (!data.transcript || !data.notes) throw new Error(); loadProject(data); } catch { showError('Project JSON không hợp lệ.'); } });
$('#audioPlayer').addEventListener('loadedmetadata', () => { if (state.file && !state.recordSession) { state.duration = Number($('#audioPlayer').duration) || 0; $('#fileMeta').textContent = `${bytes(state.file.size)} · ${humanDuration(state.duration)}`; } });
attachPlaylist($('#resultAudio')); attachPlaylist($('#audioPlayer'));

$$('#tabbar [data-apptab]').forEach(button => button.addEventListener('click', () => setAppTab(button.dataset.apptab)));
$('#qaLibrary').addEventListener('click', () => { updateLibrary(); $('#libraryDialog').showModal(); });
$('#qaInfo').addEventListener('click', () => $('#infoDialog').showModal());
$('#qaAsk').addEventListener('click', () => {
  if (!state.notes) return showError('Chưa có biên bản trong phiên này.', 'Ghi âm hoặc chọn file rồi bấm Phân tích, hoặc mở biên bản cũ từ Thư viện.');
  setAppTab('notes');
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === 'ask'));
  $$('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === 'askPanel'));
});
$('#notesEmptyRecord').addEventListener('click', () => setAppTab('record'));
$('#notesEmptyLibrary').addEventListener('click', () => { updateLibrary(); $('#libraryDialog').showModal(); });

window.addEventListener('beforeunload', event => { if (state.recording) { event.preventDefault(); event.returnValue = ''; } });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
loadSettings(); updateLibrary(); checkRecovery();
