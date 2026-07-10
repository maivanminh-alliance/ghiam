const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const HISTORY_KEY = 'meetingmind_pro_history_v1';
const APP_VERSION = '4.0.0';

const state = {
  file: null, audioUrl: '', worker: null, transcript: [], notes: null, duration: 0,
  startedAt: 0, webgpu: false, highlights: [], askHistory: [], images: [],
  mediaRecorder: null, recordChunks: [], recordStartedAt: 0, recordTimer: null,
};

const modelNames = { tiny: 'Whisper Tiny', base: 'Whisper Base', small: 'Whisper Small' };

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function bytes(size) { if (!size) return '0 B'; const units = ['B', 'KB', 'MB', 'GB']; const i = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 3); return `${(size / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`; }
function clock(seconds) { const n = Math.max(0, Math.floor(Number(seconds) || 0)); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60; return h ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
function humanDuration(seconds) { const n = Math.max(0, Math.round(Number(seconds) || 0)); const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60; return [h ? `${h} giờ` : '', m ? `${m} phút` : '', `${s} giây`].filter(Boolean).join(' '); }
function isIOSDevice() { return /iPad|iPhone|iPod/iu.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
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

function setProgress(percent, title, copy, stage = 1) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  $('#progressNumber').textContent = `${p}%`; $('#progressRing').style.setProperty('--p', p); $('#progressBar').style.width = `${p}%`;
  if (title) $('#progressTitle').textContent = title; if (copy) $('#progressCopy').textContent = copy;
  ['stageAudio', 'stageTranscript', 'stageNotes'].forEach((id, index) => { const el = $(`#${id}`); el.classList.toggle('done', index + 1 < stage); el.classList.toggle('active', index + 1 === stage); });
}

function showView(name) { $('#landingView').hidden = name !== 'landing'; $('#processingView').hidden = name !== 'processing'; $('#resultsView').hidden = name !== 'results'; window.scrollTo({ top: 0, behavior: 'smooth' }); }
function showError(message, help = 'Hãy thử Chrome/Edge mới nhất, chọn mô hình nhẹ hơn hoặc dùng file ngắn hơn.') { $('#errorMessage').textContent = message; $('#errorHelp').textContent = help; $('#errorDialog').showModal(); }

async function detectDevice() {
  state.webgpu = Boolean(navigator.gpu);
  const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
  if (mobile || !state.webgpu) $('#qualitySelect').value = 'tiny';
  $('#deviceTitle').textContent = state.webgpu ? 'Thiết bị hỗ trợ WebGPU' : 'Thiết bị dùng chế độ tương thích';
  $('#deviceCopy').textContent = state.webgpu ? 'AI sẽ sử dụng GPU để tăng tốc xử lý.' : 'AI chạy bằng WASM trên CPU; nên chọn chế độ Nhanh.';
}

function setFile(file) {
  if (!file) return; if (file.size > 500 * 1024 * 1024) return showError('File vượt quá giới hạn 500 MB.');
  state.file = file; if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); state.audioUrl = URL.createObjectURL(file);
  $('#audioPlayer').src = state.audioUrl; $('#resultAudio').src = state.audioUrl; $('#fileName').textContent = file.name; $('#fileMeta').textContent = `${bytes(file.size)} · ${file.type || 'Tệp âm thanh'}`;
  $('#dropzone').hidden = true; $('#fileCard').hidden = false; $('#startButton').disabled = false;
}

function removeFile() {
  state.file = null; $('#audioInput').value = ''; $('#audioPlayer').removeAttribute('src'); $('#resultAudio').removeAttribute('src');
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl); state.audioUrl = ''; $('#dropzone').hidden = false; $('#fileCard').hidden = true; $('#startButton').disabled = true;
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
  worker.onmessage = handleWorkerMessage; worker.onerror = event => handleFailure(new Error(event.message || 'AI worker gặp lỗi.')); return worker;
}

async function startAnalysis() {
  if (!state.file) return;
  if (location.protocol === 'file:') return showError('Không thể chạy AI khi mở trực tiếp file HTML.', 'Hãy đưa thư mục lên GitHub Pages hoặc chạy bằng localhost.');
  showView('processing'); state.startedAt = Date.now(); state.highlights = []; state.askHistory = [];
  setProgress(3, 'Đang đọc file ghi âm…', 'Giao diện đã nhận lệnh. Vui lòng không đóng tab.', 1);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    const isLongM4a = /\.(m4a|mp4)$/iu.test(state.file.name);
    const duration = state.duration || await ensureAudioDuration();
    let quality = $('#qualitySelect').value;
    if (isIOSDevice() && duration > 8 * 60) {
      showView('landing');
      showError('iPhone không thể xử lý an toàn bản ghi dài này hoàn toàn cục bộ.', `File dài ${humanDuration(duration)}. Hãy phân tích trên MacBook bằng chế độ Nhanh, sau đó xuất Project JSON và nhập lại trên iPhone. Không có file âm thanh nào được gửi lên máy chủ.`);
      return;
    }
    if (duration >= 45 * 60 && quality !== 'tiny') {
      quality = 'tiny';
      $('#qualitySelect').value = 'tiny';
      setProgress(4, 'Đã bật chế độ an toàn bộ nhớ', 'File trên 45 phút được tự chuyển sang mô hình Nhanh để tránh giật, lag hoặc văng tab.', 1);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    if (isLongM4a && !isIOSDevice()) {
      setProgress(5, 'Đang chuẩn bị file M4A…', 'Mỗi phần 10 phút sẽ được giải mã, phiên âm rồi giải phóng khỏi RAM.', 1);
      createWorker().postMessage({ type: 'transcribe', file: state.file, filename: state.file.name, quality, language: $('#languageSelect').value, webgpu: state.webgpu });
    } else {
      const audio = await decodeAudio(state.file);
      setProgress(10, 'Đang tải mô hình phiên âm…', `Chế độ ${modelNames[quality]}. Lần đầu có thể mất vài phút.`, 2);
      createWorker().postMessage({ type: 'transcribe', audio, filename: state.file.name, quality, language: $('#languageSelect').value, webgpu: state.webgpu }, [audio.buffer]);
    }
  } catch (error) { handleFailure(error); }
}

function generationContext() {
  return {
    template: $('#templateSelect').value,
    context: $('#contextInput').value.trim(),
    vocabulary: $('#vocabularyInput').value.trim(),
    images: state.images.map(file => file.name),
  };
}

function handleWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === 'progress') {
    if (message.phase === 'asr-download') setProgress(10 + message.value * .28, 'Đang tải mô hình phiên âm…', message.detail || 'Mô hình được lưu trong bộ nhớ đệm.', 2);
    if (message.phase === 'container-read') setProgress(5 + message.value * .05, 'Đang đọc cấu trúc M4A theo từng phần…', message.detail || 'Không nạp toàn bộ file vào RAM.', 1);
    if (message.phase === 'audio-decode') setProgress(35 + message.value * .32, 'Đang giải mã và phiên âm cuốn chiếu…', message.detail || 'Đang chuẩn bị âm thanh 16 kHz cho AI.', 2);
    if (message.phase === 'asr-run') setProgress(40 + message.value * .28, 'Đang chuyển giọng nói thành văn bản…', message.detail || 'Whisper đang nghe và tạo mốc thời gian.', 2);
    if (message.phase === 'llm-download') setProgress(70 + message.value * .18, 'Đang tải mô hình viết biên bản…', message.detail || 'Chỉ cần tải một lần trên thiết bị này.', 3);
    if (message.phase === 'llm-run') setProgress(90 + message.value * .08, 'Đang phân tích toàn bộ cuộc hội thoại…', message.detail || 'AI đang trích xuất quyết định, rủi ro và đầu việc.', 3);
    return;
  }
  if (message.type === 'transcript') {
    if (!Array.isArray(message.transcript) || !message.transcript.some(row => String(row.text || '').trim())) {
      handleFailure(new Error('AI không tạo được transcript từ file này nên chưa thể lập biên bản. Hãy thử Chrome/Edge mới nhất hoặc file M4A ngắn hơn.'));
      return;
    }
    state.transcript = (message.transcript || []).map(row => ({ ...row, speaker: 'Người nói 1' }));
    setProgress(70, 'Transcript đã hoàn tất', 'Đang tạo biên bản theo mẫu đã chọn.', 3);
    state.worker.postMessage({ type: 'summarize', transcript: state.transcript, filename: state.file.name, webgpu: state.webgpu, ...generationContext() }); return;
  }
  if (message.type === 'result') {
    state.notes = message.notes; setProgress(100, 'Biên bản đã hoàn tất', message.fallback ? 'Đã dùng chế độ tóm tắt nhẹ.' : 'Toàn bộ nội dung được xử lý trên thiết bị.', 3);
    setTimeout(renderResults, 400); return;
  }
  if (message.type === 'answer') {
    state.askHistory.push({ role: 'answer', text: message.answer, references: message.references || [] }); renderAskHistory(); $('#askInput').disabled = false; $('#askForm button').disabled = false; return;
  }
  if (message.type === 'error') handleFailure(new Error(message.error || 'Không thể xử lý bằng AI.'));
}

function handleFailure(error) {
  if (state.worker) state.worker.terminate(); state.worker = null; showView('landing');
  const raw = error.message || 'Không thể xử lý file.';
  if (isIOSDevice() && /(decod|operationerror|audio)/iu.test(raw)) {
    showError('iPhone không giải mã được bản ghi này trong chế độ AI cục bộ.', 'Chrome trên iPhone vẫn dùng bộ máy WebKit của iOS. Hãy phân tích bản ghi dài trên MacBook, rồi xuất Project JSON để xem trên iPhone.');
    return;
  }
  showError(raw);
}

function renderResults() {
  const notes = state.notes || {}; const title = notes.title && notes.title !== 'Chưa xác định' ? notes.title : (state.file?.name || 'Cuộc họp').replace(/\.[^.]+$/, '');
  $('#meetingTitle').value = title; $('#resultAudio').src = state.audioUrl || '';
  const elapsed = Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)); $('#meetingMeta').textContent = `${new Date().toLocaleString('vi-VN')} · ${humanDuration(state.duration)} · xử lý trong ${elapsed} giây`;
  $('#wordCount').textContent = state.transcript.reduce((n, row) => n + row.text.split(/\s+/).filter(Boolean).length, 0).toLocaleString('vi-VN'); $('#decisionCount').textContent = (notes.decisions || []).length; $('#actionCount').textContent = (notes.actions || []).length;
  const coverage = notes.coverage || {}; const warnings = coverage.warnings || [];
  const coveragePanel = coverage.totalChunks ? `<div class="coverage-card"><div><b>${coverage.percent || 0}% transcript đã phân tích</b><span>${coverage.processedChunks}/${coverage.totalChunks} khối liên tiếp · ${coverage.lowConfidence || 0} kết luận cần kiểm tra</span></div><span class="coverage-badge">FULL PASS</span>${warnings.length ? `<details><summary>${warnings.length} cảnh báo chất lượng</summary><ul>${warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}</div>` : '';
  $('#summaryPanel').innerHTML = `${coveragePanel}<div class="section-label">Tóm tắt điều hành</div><p class="summary-text">${escapeHtml(notes.summary || 'Chưa có tóm tắt.')}</p><div class="section-label">Điểm chính</div><ul class="notes-list evidence-notes">${(notes.keyPoints || []).map(point => `<li><span>${escapeHtml(factText(point))}</span>${evidenceHtml(point)}</li>`).join('') || '<li>Chưa xác định.</li>'}</ul>${(notes.risks || []).length ? `<div class="section-label section-space">Rủi ro &amp; vướng mắc</div><ul class="notes-list evidence-notes">${notes.risks.map(item => `<li><span>${escapeHtml(factText(item))}</span>${evidenceHtml(item)}</li>`).join('')}</ul>` : ''}${state.images.length ? `<div class="section-label section-space">Tài liệu tham chiếu</div><ul class="notes-list">${state.images.map(file => `<li>Ảnh: ${escapeHtml(file.name)}</li>`).join('')}</ul>` : ''}`;
  renderTranscript();
  $('#decisionsPanel').innerHTML = `<div class="section-label">Các quyết định đã ghi nhận</div><div class="decision-list">${(notes.decisions || []).map((item, i) => `<div class="decision-item${item.confidence === 'low' ? ' low-confidence' : ''}"><b>${String(i + 1).padStart(2, '0')}. ${escapeHtml(factText(item))}</b>${item.context ? `<small>${escapeHtml(item.context)}</small>` : ''}${evidenceHtml(item)}</div>`).join('') || '<p>Chưa ghi nhận quyết định rõ ràng.</p>'}</div>`;
  $('#actionsPanel').innerHTML = `<div class="section-label">Danh sách việc cần làm</div><div class="action-list">${(notes.actions || []).map(item => `<div class="action-item${item.confidence === 'low' ? ' low-confidence' : ''}"><input type="checkbox" aria-label="Đánh dấu hoàn thành"><span><span class="owner">${escapeHtml(item.owner || 'Chưa xác định')}</span><span class="action-text">${escapeHtml(factText(item))}</span>${evidenceHtml(item)}</span><span class="due">${escapeHtml(item.due || 'Chưa xác định')}</span></div>`).join('') || '<p>Chưa ghi nhận đầu việc rõ ràng.</p>'}</div>`;
  renderMindMap(); renderAskHistory(); updateHighlightCount(); saveHistory(); showView('results');
}

function renderTranscript(query = '') {
  const term = query.trim().toLocaleLowerCase('vi');
  const rows = state.transcript.map((row, i) => {
    let text = escapeHtml(row.text); if (term && row.text.toLocaleLowerCase('vi').includes(term)) text = text.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu'), '<mark>$1</mark>');
    const highlighted = state.highlights.some(item => Math.abs(item.time - row.start) < 8);
    return `<article class="transcript-row${highlighted ? ' highlight-row' : ''}"><button class="timestamp" type="button" data-seconds="${Number(row.start) || 0}">${escapeHtml(row.time)} ▶</button><input class="speaker-input" data-speaker-index="${i}" value="${escapeHtml(row.speaker || 'Người nói 1')}" aria-label="Tên người nói"><p>${text}</p></article>`;
  }).join('');
  $('#transcriptPanel').innerHTML = `<div class="transcript-tools"><input id="transcriptSearch" placeholder="Tìm trong transcript…" value="${escapeHtml(query)}"><span>${state.transcript.length} đoạn</span></div>${rows}`;
  $('#transcriptSearch').addEventListener('input', event => renderTranscript(event.target.value));
}

function renderMindMap() {
  const notes = state.notes || {};
  const branch = (title, items) => `<section class="mind-branch"><strong>${title}</strong><ul>${(items || []).map(item => `<li>${escapeHtml(item.text || item)}</li>`).join('') || '<li>Chưa có dữ liệu</li>'}</ul></section>`;
  $('#mindmapPanel').innerHTML = `<div class="mindmap"><div class="mind-root">${escapeHtml($('#meetingTitle').value || notes.title)}</div><div class="mind-branches">${branch('Điểm chính', notes.keyPoints)}${branch('Quyết định', notes.decisions)}${branch('Hành động', notes.actions)}</div></div>`;
}

function renderAskHistory() {
  $('#askHistory').innerHTML = state.askHistory.map(item => `<div class="ask-bubble ${item.role === 'question' ? 'question' : 'answer'}">${escapeHtml(item.text)}${item.references?.length ? `<small>Tham chiếu: ${item.references.map(clock).join(', ')}</small>` : ''}</div>`).join('');
}

function updateHighlightCount() { $('#highlightCount').textContent = `${state.highlights.length} highlights`; }

function addHighlight() {
  const player = $('#resultAudio'); const time = player.currentTime || 0; const note = prompt(`Ghi chú tại ${clock(time)}:`, '') ?? '';
  state.highlights.push({ time, note, createdAt: Date.now() }); updateHighlightCount(); renderTranscript($('#transcriptSearch')?.value || ''); saveHistory();
}

function markdown() {
  const n = state.notes || {};
  const refs = item => item?.evidence?.length ? ` [${item.evidence.join(', ')}]` : '';
  return `# ${$('#meetingTitle').value}\n\n- Thời gian: ${new Date().toLocaleString('vi-VN')}\n- Thời lượng: ${humanDuration(state.duration)}\n- Mẫu: ${$('#templateSelect').value}\n- Độ bao phủ transcript: ${n.coverage?.percent ?? 'Chưa xác định'}%\n\n## Tóm tắt\n\n${n.summary || ''}\n\n## Điểm chính\n\n${(n.keyPoints || []).map(x => `- ${factText(x)}${refs(x)}`).join('\n')}\n\n## Quyết định\n\n${(n.decisions || []).map((x, i) => `${i + 1}. ${factText(x)}${x.context ? ` — ${x.context}` : ''}${refs(x)}`).join('\n')}\n\n## Việc cần làm\n\n${(n.actions || []).map(x => `- [ ] ${factText(x)} — ${x.owner || 'Chưa xác định'} — ${x.due || 'Chưa xác định'}${refs(x)}`).join('\n')}\n\n## Rủi ro\n\n${(n.risks || []).map(x => `- ${factText(x)}${refs(x)}`).join('\n')}\n\n## Highlights\n\n${state.highlights.map(x => `- ${clock(x.time)} — ${x.note || 'Đã đánh dấu'}`).join('\n')}\n\n## Transcript\n\n${state.transcript.map(x => `**${x.time} — ${x.speaker || 'Người nói'}:** ${x.text}`).join('\n\n')}\n`;
}

function srtTime(seconds) { const n = Math.max(0, Number(seconds) || 0), h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = Math.floor(n % 60), ms = Math.floor((n % 1) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`; }
function srt() { return state.transcript.map((x, i) => `${i + 1}\n${srtTime(x.start)} --> ${srtTime(x.end || x.start + 3)}\n${x.speaker || 'Người nói'}: ${x.text}\n`).join('\n'); }
function projectData() { return { version: 1, title: $('#meetingTitle').value, date: new Date().toISOString(), duration: state.duration, transcript: state.transcript, notes: state.notes, highlights: state.highlights, askHistory: state.askHistory, context: generationContext() }; }

function downloadFile(extension, content, type = 'text/plain') { const blob = new Blob([content], { type: `${type};charset=utf-8` }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${($('#meetingTitle').value || 'bien-ban').replace(/[\\/:*?"<>|]/g, '-')}.${extension}`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 500); return blob; }

async function exportAs(type) {
  if (type === 'md') downloadFile('md', markdown(), 'text/markdown');
  if (type === 'txt') downloadFile('txt', markdown().replace(/[#*_`]/g, ''));
  if (type === 'srt') downloadFile('srt', srt(), 'application/x-subrip');
  if (type === 'json') downloadFile('json', JSON.stringify(projectData(), null, 2), 'application/json');
  if (type === 'pdf') { $('#exportDialog').close(); window.print(); return; }
  if (type === 'share') {
    const file = new File([markdown()], `${$('#meetingTitle').value || 'bien-ban'}.md`, { type: 'text/markdown' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: $('#meetingTitle').value, files: [file] }); else downloadFile('md', markdown(), 'text/markdown');
  }
  $('#exportDialog').close();
}

function getHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function saveHistory() { const item = projectData(); item.id = state.currentId || crypto.randomUUID(); state.currentId = item.id; const history = [item, ...getHistory().filter(x => x.id !== item.id)].slice(0, 12); try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {} updateLibrary(); }
function updateLibrary() { const history = getHistory(); $('#libraryCount').textContent = history.length; $('#libraryList').innerHTML = history.length ? history.map(item => `<div class="library-item"><div><b>${escapeHtml(item.title || 'Biên bản')}</b><small>${new Date(item.date).toLocaleString('vi-VN')} · ${humanDuration(item.duration)}</small></div><button data-load-id="${item.id}">Mở</button><button class="delete" data-delete-id="${item.id}">Xóa</button></div>`).join('') : '<div class="library-empty">Chưa có biên bản trên thiết bị này.</div>'; }
function loadProject(item) { state.currentId = item.id || crypto.randomUUID(); state.file = { name: item.title || 'Biên bản đã lưu' }; state.duration = item.duration || 0; state.transcript = item.transcript || []; state.notes = item.notes || {}; state.highlights = item.highlights || []; state.askHistory = item.askHistory || []; state.audioUrl = ''; $('#libraryDialog').close(); state.startedAt = Date.now(); renderResults(); }

async function toggleRecording() {
  if (state.mediaRecorder?.state === 'recording') { state.mediaRecorder.stop(); return; }
  try {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Trình duyệt không hỗ trợ ghi âm trực tiếp.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.recordChunks = [];
    const supportedTypes = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'].filter(type => MediaRecorder.isTypeSupported?.(type));
    const mimeType = supportedTypes[0] || '';
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.mediaRecorder = recorder; state.recordStartedAt = Date.now(); $('#recordButton').classList.add('recording'); $('#recordLabel').textContent = 'Đang ghi — bấm để dừng';
    state.recordTimer = setInterval(() => $('#recordTime').textContent = clock((Date.now() - state.recordStartedAt) / 1000), 500);
    recorder.ondataavailable = event => { if (event.data.size) state.recordChunks.push(event.data); };
    recorder.onerror = () => { clearInterval(state.recordTimer); stream.getTracks().forEach(track => track.stop()); state.mediaRecorder = null; showError('Không thể ghi âm trực tiếp.', 'Hãy cấp quyền Micro cho GitHub Pages trong cài đặt trình duyệt rồi thử lại.'); };
    recorder.onstop = () => { clearInterval(state.recordTimer); stream.getTracks().forEach(track => track.stop()); state.mediaRecorder = null; $('#recordButton').classList.remove('recording'); $('#recordLabel').textContent = 'Ghi âm trực tiếp bằng micro'; const blob = new Blob(state.recordChunks, { type: recorder.mimeType || 'audio/webm' }); if (!blob.size) return showError('Bản ghi rỗng.', 'Hãy nói ít nhất vài giây trước khi bấm dừng.'); const ext = blob.type.includes('mp4') ? 'm4a' : 'webm'; setFile(new File([blob], `Ghi âm ${new Date().toLocaleString('vi-VN').replace(/[/:]/g, '-')}.${ext}`, { type: blob.type })); };
    recorder.start(1000);
  } catch (error) { showError(error.message || 'Không thể truy cập micro.', 'Hãy cấp quyền Micro cho GitHub Pages trong cài đặt trình duyệt.'); }
}

function resetApp() { if (state.worker) state.worker.terminate(); state.worker = null; removeFile(); state.transcript = []; state.notes = null; state.highlights = []; state.askHistory = []; state.images = []; state.currentId = null; $('#imageInput').value = ''; $('#imageCount').textContent = 'Chưa có ảnh'; showView('landing'); }

$('#audioInput').addEventListener('change', event => setFile(event.target.files[0])); $('#removeFile').addEventListener('click', removeFile); $('#startButton').addEventListener('click', startAnalysis); $('#newButton').addEventListener('click', resetApp); $('#recordButton').addEventListener('click', toggleRecording);
$('#exportButton').addEventListener('click', () => $('#exportDialog').showModal()); $('#infoButton').addEventListener('click', () => $('#infoDialog').showModal()); $('#libraryButton').addEventListener('click', () => { updateLibrary(); $('#libraryDialog').showModal(); }); $('#highlightButton').addEventListener('click', addHighlight);
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close())); $$('[data-export]').forEach(button => button.addEventListener('click', () => exportAs(button.dataset.export)));
$('#imageInput').addEventListener('change', event => { state.images = [...event.target.files].slice(0, 6); $('#imageCount').textContent = state.images.length ? `${state.images.length} ảnh` : 'Chưa có ảnh'; });

['dragenter', 'dragover'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach(name => $('#dropzone').addEventListener(name, event => { event.preventDefault(); $('#dropzone').classList.remove('drag'); if (name === 'drop') setFile(event.dataTransfer.files[0]); }));
$$('.tab').forEach(tab => tab.addEventListener('click', () => { $$('.tab').forEach(item => item.classList.toggle('active', item === tab)); $$('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === `${tab.dataset.tab}Panel`)); }));
$('#transcriptPanel').addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button || !state.audioUrl) return; $('#resultAudio').currentTime = Number(button.dataset.seconds) || 0; $('#resultAudio').play(); });
['summaryPanel', 'decisionsPanel', 'actionsPanel'].forEach(id => $(`#${id}`).addEventListener('click', event => { const button = event.target.closest('[data-seconds]'); if (!button || !state.audioUrl) return; $('#resultAudio').currentTime = Number(button.dataset.seconds) || 0; $('#resultAudio').play(); }));
$('#transcriptPanel').addEventListener('change', event => { const input = event.target.closest('[data-speaker-index]'); if (!input) return; state.transcript[Number(input.dataset.speakerIndex)].speaker = input.value.trim() || 'Người nói'; saveHistory(); });
$('#actionsPanel').addEventListener('change', event => { const item = event.target.closest('.action-item'); if (item) item.classList.toggle('done', event.target.checked); });
$('#meetingTitle').addEventListener('change', () => { renderMindMap(); saveHistory(); });
$('#askForm').addEventListener('submit', event => { event.preventDefault(); const question = $('#askInput').value.trim(); if (!question) return; state.askHistory.push({ role: 'question', text: question }); renderAskHistory(); $('#askInput').value = ''; $('#askInput').disabled = true; $('#askForm button').disabled = true; const worker = state.worker || createWorker(); worker.postMessage({ type: 'ask', transcript: state.transcript, question, webgpu: state.webgpu }); });
$('#libraryList').addEventListener('click', event => { const load = event.target.closest('[data-load-id]'), del = event.target.closest('[data-delete-id]'); if (load) { const item = getHistory().find(x => x.id === load.dataset.loadId); if (item) loadProject(item); } if (del) { localStorage.setItem(HISTORY_KEY, JSON.stringify(getHistory().filter(x => x.id !== del.dataset.deleteId))); updateLibrary(); } });
$('#importInput').addEventListener('change', async event => { try { const data = JSON.parse(await event.target.files[0].text()); if (!data.transcript || !data.notes) throw new Error(); loadProject(data); } catch { showError('Project JSON không hợp lệ.'); } });
$('#audioPlayer').addEventListener('loadedmetadata', () => { if (state.file) { state.duration = Number($('#audioPlayer').duration) || 0; $('#fileMeta').textContent = `${bytes(state.file.size)} · ${humanDuration(state.duration)}`; } });

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
detectDevice(); updateLibrary();
