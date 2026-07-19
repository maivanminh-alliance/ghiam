// mp4box 0.5.2: bản 2.x không phát onSamples với file M4A từ Voice Memos (moov ở cuối file)
import * as MP4BoxModule from 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm';
const createMp4File = () => (MP4BoxModule.default || MP4BoxModule).createFile();

const API_BASE = 'https://api.openai.com/v1';
const ENTERPRISE_BACKEND = 'https://meetingmind-openai-backend.meetingmind-minh.workers.dev';
const usageTotals = { inputTokens: 0, outputTokens: 0 };

function progress(phase, value, detail = '', meta = {}) {
  self.postMessage({ type: 'progress', phase, value: Math.max(0, Math.min(100, Number(value) || 0)), detail, ...meta });
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ---------- Gọi OpenAI ----------
function apiErrorMessage(status, payload) {
  const code = payload?.error?.code || '';
  const detail = payload?.error?.message || '';
  if (status === 401) return 'API key không đúng hoặc đã bị thu hồi. Kiểm tra lại tại platform.openai.com/api-keys.';
  if (code === 'insufficient_quota') return 'Tài khoản OpenAI đã hết hạn mức. Vào platform.openai.com → Billing để nạp thêm credit.';
  if (status === 429) return 'OpenAI đang giới hạn tốc độ. Đợi khoảng một phút rồi thử lại.';
  if (status === 413 || /too large/iu.test(detail)) return 'File gửi lên vượt giới hạn 25 MB của OpenAI.';
  if (code === 'model_not_found') return `Model không khả dụng với API key này: ${detail}`;
  return detail || `Lỗi OpenAI (HTTP ${status}).`;
}

async function apiFetch(path, { apiKey, body, isForm = false }) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
        body,
      });
    } catch (error) { lastError = new Error('Không kết nối được tới api.openai.com. Kiểm tra mạng.'); continue; }
    if (response.ok) return response.json();
    const payload = await response.json().catch(() => null);
    const error = new Error(apiErrorMessage(response.status, payload));
    error.status = response.status;
    error.code = payload?.error?.code || '';
    const retryable = response.status >= 500 || (response.status === 429 && error.code !== 'insufficient_quota');
    if (!retryable) throw error;
    lastError = error;
  }
  throw lastError || new Error('Không thể gọi OpenAI.');
}

function trackUsage(data) {
  usageTotals.inputTokens += Number(data?.usage?.prompt_tokens || data?.usage?.input_tokens || 0);
  usageTotals.outputTokens += Number(data?.usage?.completion_tokens || data?.usage?.output_tokens || 0);
}

// ---------- Phiên âm ----------
function extFromMime(mimeType = '') {
  if (/mp4|aac/iu.test(mimeType)) return 'm4a';
  if (/webm/iu.test(mimeType)) return 'webm';
  if (/ogg/iu.test(mimeType)) return 'ogg';
  if (/wav/iu.test(mimeType)) return 'wav';
  if (/mpeg|mp3/iu.test(mimeType)) return 'mp3';
  return 'webm';
}

async function transcribeBlob(blob, filename, message) {
  const buildForm = model => {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', model);
    if (model === 'whisper-1') {
      form.append('response_format', 'verbose_json');
      if (message.language && message.language !== 'auto') form.append('language', message.language);
      if (message.vocabulary) form.append('prompt', message.vocabulary);
    } else {
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
    }
    return form;
  };
  try {
    return await apiFetch('/audio/transcriptions', { apiKey: message.apiKey, body: buildForm(message.sttModel), isForm: true });
  } catch (error) {
    if (error.code === 'model_not_found' && message.sttModel !== 'whisper-1') {
      progress('asr-run', 0, 'Model tách người nói không khả dụng — chuyển sang Whisper…');
      message.sttModel = 'whisper-1';
      return apiFetch('/audio/transcriptions', { apiKey: message.apiKey, body: buildForm('whisper-1'), isForm: true });
    }
    throw error;
  }
}

async function enterpriseTranscribeBlob(blob, filename, signal) {
  const form = new FormData();
  form.append('file', blob, filename);
  let response;
  try {
    response = await fetch(`${ENTERPRISE_BACKEND}/transcribe`, { method: 'POST', body: form, signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Backend không phản hồi sau 20 phút. Ứng dụng đã dừng phần này để tránh chờ vô hạn; không tự gửi lại để tránh phát sinh phí trùng.');
    throw new Error('Không kết nối được backend khi gửi phần âm thanh. Kiểm tra mạng rồi thử lại.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Backend không phiên âm được phần âm thanh: ${String(detail).slice(0, 500)}`);
  }
  if (!Array.isArray(payload?.transcript)) throw new Error('Backend trả transcript phần âm thanh không hợp lệ.');
  return payload;
}

function appendEnterpriseChunkRows(target, rows, offsetSeconds, chunkIndex) {
  for (const row of rows || []) {
    const text = String(row?.text || '').trim();
    if (!text) continue;
    const rawSpeaker = String(row.originalSpeaker || row.speaker || 'Người nói chưa xác định');
    // Diarization có thể đánh lại SPEAKER_00 ở mỗi request. Gắn số phần để tránh
    // tự đồng nhất nhầm hai người; người dùng sẽ gán cùng tên nếu đúng là một người.
    const scopedSpeaker = `Phần ${chunkIndex + 1} · ${rawSpeaker}`;
    const start = offsetSeconds + (Number(row.start) || 0);
    const end = offsetSeconds + Math.max(Number(row.end) || 0, Number(row.start) || 0);
    target.push({
      ...row,
      id: target.length + 1,
      start,
      end,
      time: formatClock(start),
      speaker: scopedSpeaker,
      originalSpeaker: scopedSpeaker,
      sourceChunk: chunkIndex + 1,
      sourceSpeaker: rawSpeaker,
    });
  }
}

async function transcribeEnterpriseLarge(message) {
  if (!message.file) throw new Error('Thiếu file M4A để xử lý theo từng phần.');
  const transcript = [];
  await decodeM4a(message.file, async (audio, index, total) => {
    const offset = index * 600;
    const blob = wavBlob(audio);
    const partProgress = 4 + index / Math.max(1, total) * 92;
    const partRange = `${formatClock(offset)}–${formatClock(offset + audio.length / 16000)}`;
    const startedAt = Date.now();
    progress('asr-run', partProgress, `Đang gửi phần ${index + 1}/${total} (${partRange}) tới backend…`);
    const heartbeat = () => {
      const waitedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const waitNote = waitedSeconds >= 600 ? 'đang chờ lâu hơn bình thường' : 'trang vẫn hoạt động';
      progress('asr-wait', partProgress, `Phần ${index + 1}/${total} (${partRange}) đang được backend/OpenAI xử lý · đã chờ ${formatClock(waitedSeconds)} · ${waitNote}.`, { waitedSeconds, part: index + 1, totalParts: total });
    };
    heartbeat();
    const heartbeatId = setInterval(heartbeat, 5000);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20 * 60 * 1000);
    // WAV mono 16 kHz 10 phút ~19,2 MB, nằm dưới giới hạn 25 MB của Audio API.
    try {
      const data = await enterpriseTranscribeBlob(blob, `meeting-part-${index + 1}.wav`, controller.signal);
      const waitedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      progress('asr-wait', partProgress, `Đã nhận kết quả phần ${index + 1}/${total} sau ${formatClock(waitedSeconds)}.`, { waitedSeconds, part: index + 1, totalParts: total });
      appendEnterpriseChunkRows(transcript, data.transcript, offset, index);
    } finally {
      clearInterval(heartbeatId);
      clearTimeout(timeoutId);
    }
  });
  transcript.sort((a, b) => a.start - b.start);
  if (!transcript.some(row => row.text)) throw new Error('Backend không tạo được transcript từ các phần âm thanh.');
  progress('asr-run', 100, 'Đã phiên âm xong toàn bộ các phần.');
  self.postMessage({ type: 'enterprise-transcript', transcript, chunked: true });
}

const speakerNames = new Map();
function speakerLabel(raw) {
  if (raw == null || raw === '') return '';
  const cleaned = String(raw).replace(/^speaker[_\s-]*/iu, '').trim() || String(raw);
  if (!speakerNames.has(cleaned)) speakerNames.set(cleaned, `Người nói ${cleaned}`);
  return speakerNames.get(cleaned);
}

function appendRows(transcript, data, offset) {
  trackUsage(data);
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const rows = segments.map(segment => {
    const start = offset + (Number(segment.start) || 0);
    const end = offset + (Number(segment.end) || 0);
    return { start, end: end > start ? end : start, time: formatClock(start), text: String(segment.text || '').trim(), speaker: speakerLabel(segment.speaker) };
  }).filter(row => row.text);
  if (!rows.length && String(data?.text || '').trim()) rows.push({ start: offset, end: offset, time: formatClock(offset), text: String(data.text).trim(), speaker: '' });
  transcript.push(...rows);
}

function wavBlob(float32, sampleRate = 16000) {
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

function splitPcm(audio, segmentSize = 16000 * 10 * 60) {
  const segments = [];
  for (let offset = 0; offset < audio.length; offset += segmentSize) segments.push(audio.slice(offset, Math.min(audio.length, offset + segmentSize)));
  return segments;
}

// ---------- Giải mã M4A cuốn chiếu (giữ từ V5) ----------
function downsampleAudioData(audioData, targetRate = 16000) {
  const frames = audioData.numberOfFrames;
  const channels = audioData.numberOfChannels;
  const mono = new Float32Array(frames);
  for (let channel = 0; channel < channels; channel += 1) {
    const plane = new Float32Array(frames);
    audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
    for (let index = 0; index < frames; index += 1) mono[index] += plane[index] / channels;
  }
  if (audioData.sampleRate === targetRate) return mono;
  const ratio = audioData.sampleRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.floor(frames / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(frames - 1, left + 1);
    const fraction = position - left;
    output[index] = mono[left] * (1 - fraction) + mono[right] * fraction;
  }
  return output;
}

function audioSpecificConfig(mp4File, trackId) {
  const trak = mp4File.moov?.traks?.find(item => item.tkhd?.track_id === trackId) || mp4File.moov?.traks?.[0];
  const descriptor = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
  return descriptor ? new Uint8Array(descriptor) : undefined;
}

function adtsFrame(data, sampleRate = 48000, channels = 2) {
  const frequencyIndex = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8 }[sampleRate] ?? 3;
  const frameLength = data.byteLength + 7;
  const header = new Uint8Array(7);
  header[0] = 0xff; header[1] = 0xf1; header[2] = (1 << 6) | (frequencyIndex << 2) | ((channels >> 2) & 1);
  header[3] = ((channels & 3) << 6) | ((frameLength >> 11) & 3); header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 7) << 5) | 0x1f; header[6] = 0xfc;
  const frame = new Uint8Array(frameLength); frame.set(header); frame.set(new Uint8Array(data), 7); return frame;
}

async function decodeM4a(file, onSegment) {
  if (typeof AudioDecoder === 'undefined' || typeof EncodedAudioChunk === 'undefined') {
    throw new Error('Trình duyệt này chưa hỗ trợ giải mã M4A lớn. Hãy dùng Chrome hoặc Edge bản mới nhất.');
  }
  const mp4File = createMp4File();
  const targetRate = 16000;
  const segmentSize = targetRate * 10 * 60;
  let current = new Float32Array(segmentSize);
  let currentOffset = 0;
  let processedSamples = 0;
  let segmentIndex = 0;
  let totalSegments = 1;
  const readySegments = [];
  const useAdts = /iPhone|iPad|iPod/iu.test(self.navigator?.userAgent || '');
  let track;
  let decoder;
  let settled = false;

  const appendPcm = pcm => {
    let sourceOffset = 0;
    while (sourceOffset < pcm.length) {
      const amount = Math.min(current.length - currentOffset, pcm.length - sourceOffset);
      current.set(pcm.subarray(sourceOffset, sourceOffset + amount), currentOffset);
      currentOffset += amount;
      sourceOffset += amount;
      if (currentOffset === current.length) {
        readySegments.push(current);
        current = new Float32Array(segmentSize);
        currentOffset = 0;
      }
    }
  };

  const drainSegments = async () => {
    while (readySegments.length) {
      const audio = readySegments.shift();
      await onSegment(audio, segmentIndex, totalSegments);
      segmentIndex += 1;
    }
  };

  await new Promise((resolve, reject) => {
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error || 'Không thể giải mã M4A.')));
    };
    mp4File.onError = fail;
    mp4File.onReady = async info => {
      try {
        track = info.audioTracks?.[0];
        if (!track) throw new Error('Không tìm thấy rãnh âm thanh trong file M4A.');
        totalSegments = Math.max(1, Math.ceil((track.duration / track.timescale) / (segmentSize / targetRate)));
        const config = {
          codec: track.codec,
          sampleRate: track.audio.sample_rate,
          numberOfChannels: track.audio.channel_count,
          description: useAdts ? undefined : audioSpecificConfig(mp4File, track.id),
        };
        const support = await AudioDecoder.isConfigSupported(config);
        if (!support.supported) throw new Error(`Thiết bị không giải mã được ${track.codec}.`);
        decoder = new AudioDecoder({
          output(audioData) {
            try { appendPcm(downsampleAudioData(audioData, targetRate)); }
            finally { audioData.close(); }
          },
          error: fail,
        });
        decoder.configure(support.config);
        mp4File.setExtractionOptions(track.id, null, { nbSamples: 400, rapAlignement: false });
        mp4File.start();
      } catch (error) { fail(error); }
    };
    mp4File.onSamples = (trackId, user, samples) => {
      if (settled || !samples.length) return;
      mp4File.stop();
      try {
        for (const sample of samples) {
          decoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(sample.cts * 1000000 / sample.timescale),
            duration: Math.round(sample.duration * 1000000 / sample.timescale),
            data: useAdts ? adtsFrame(sample.data, track.audio.sample_rate, track.audio.channel_count) : sample.data,
          }));
        }
      } catch (error) { fail(error); return; }
      decoder.flush().then(async () => {
        processedSamples += samples.length;
        const percent = processedSamples / Math.max(1, track.nb_samples) * 100;
        progress('audio-decode', percent, `Đang giải mã âm thanh ${Math.min(100, Math.round(percent))}%…`);
        await drainSegments();
        mp4File.releaseUsedSamples(trackId, samples.at(-1)?.number ?? processedSamples);
        if (processedSamples >= track.nb_samples) {
          if (currentOffset) readySegments.push(current.slice(0, currentOffset));
          current = null;
          currentOffset = 0;
          await drainSegments();
          decoder.close();
          settled = true;
          resolve();
        } else {
          mp4File.start();
        }
      }).catch(fail);
    };
    const chunkSize = 2 * 1024 * 1024;
    const feed = async () => {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const buffer = await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer();
        buffer.fileStart = offset; mp4File.appendBuffer(buffer);
        progress('container-read', offset / Math.max(1, file.size) * 100, `Đang đọc cấu trúc M4A ${Math.round(offset / file.size * 100)}%…`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      mp4File.flush();
    };
    feed().catch(fail);
  });

  return { segmentCount: segmentIndex, totalSegments };
}

async function transcribe(message) {
  if (message.engine === 'gemini-claude') return transcribeGemini(message);
  speakerNames.clear();
  const transcript = [];
  if (Array.isArray(message.parts) && message.parts.length) {
    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      progress('asr-run', 4 + index / message.parts.length * 92, `Đang phiên âm phần ${index + 1}/${message.parts.length}…`);
      const data = await transcribeBlob(part.blob, `part-${index + 1}.${extFromMime(part.mimeType)}`, message);
      appendRows(transcript, data, Number(part.offset) || 0);
    }
  } else if (message.stream && message.file) {
    await decodeM4a(message.file, async (audio, index, total) => {
      progress('asr-run', 4 + index / Math.max(1, total) * 90, `Đang phiên âm phần ${index + 1}/${total} (${formatClock(index * 600)}–${formatClock(index * 600 + audio.length / 16000)})…`);
      const data = await transcribeBlob(wavBlob(audio), `part-${index + 1}.wav`, message);
      appendRows(transcript, data, index * 600);
    });
    message.file = null;
  } else if (message.file) {
    progress('asr-run', 25, 'Đang tải file lên OpenAI…');
    const data = await transcribeBlob(message.file, message.filename || 'audio.m4a', message);
    appendRows(transcript, data, 0);
  } else if (message.audio) {
    const segments = splitPcm(message.audio);
    for (let index = 0; index < segments.length; index += 1) {
      progress('asr-run', 4 + index / segments.length * 92, `Đang phiên âm phần ${index + 1}/${segments.length}…`);
      const data = await transcribeBlob(wavBlob(segments[index]), `part-${index + 1}.wav`, message);
      segments[index] = null;
      appendRows(transcript, data, index * 600);
    }
  }
  transcript.sort((a, b) => a.start - b.start);
  progress('asr-run', 100, 'Transcript đã hoàn tất.');
  self.postMessage({ type: 'transcript', transcript });
}

// ---------- Chuẩn hóa biên bản ----------
function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/giu, '').replace(/```/gu, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI không trả về JSON hợp lệ.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function list(value, limit = 20) { return Array.isArray(value) ? value.slice(0, limit) : []; }
function evidenceList(value) { return [...new Set(list(value, 8).map(item => String(item || '').replace(/[\[\]]/g, '').trim()).filter(Boolean))]; }
function normalizeFactItem(item, extras = {}) {
  if (typeof item === 'string') return { text: item, evidence: [], ...extras };
  return {
    text: String(item?.text || '').trim(),
    evidence: evidenceList(item?.evidence),
    ...extras,
    ...Object.fromEntries(Object.keys(extras).map(key => [key, String(item?.[key] || extras[key])])),
  };
}
function normalizeNotes(value, filename) {
  const notes = value && typeof value === 'object' ? value : {};
  return {
    title: String(notes.title || String(filename || '').replace(/\.[^.]+$/, '') || 'Cuộc họp mới'),
    summary: String(notes.summary || 'Chưa xác định.'),
    keyPoints: list(notes.keyPoints, 14).map(item => normalizeFactItem(item)).filter(item => item.text),
    decisions: list(notes.decisions, 20).map(item => normalizeFactItem(item, { context: '' })).filter(item => item.text),
    actions: list(notes.actions, 24).map(item => normalizeFactItem(item, { owner: 'Chưa xác định', due: 'Chưa xác định' })).filter(item => item.text),
    risks: list(notes.risks, 14).map(item => normalizeFactItem(item)).filter(item => item.text),
  };
}
function heuristicNotes(transcript, filename) {
  const sentences = transcript.map(row => row.text.trim()).filter(text => text.length > 18);
  const unique = [...new Set(sentences)];
  const evidenceFor = text => transcript.find(row => row.text.trim() === text)?.time;
  const decisions = unique.filter(text => /(chốt|thống nhất|quyết định|đồng ý|phê duyệt)/iu.test(text)).slice(0, 10).map(text => ({ text, context: 'Trích từ transcript', evidence: [evidenceFor(text)].filter(Boolean) }));
  const actionPattern = /(sẽ|cần|phụ trách|hoàn thành|gửi|kiểm tra|cập nhật|chuẩn bị|thực hiện)/iu;
  const actions = unique.filter(text => actionPattern.test(text)).slice(0, 12).map(text => ({
    text, owner: 'Chưa xác định',
    due: text.match(/(?:ngày\s*)?\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?/u)?.[0] || 'Chưa xác định',
    evidence: [evidenceFor(text)].filter(Boolean),
  }));
  const keyPoints = unique.slice(0, 7).map(text => ({ text, evidence: [evidenceFor(text)].filter(Boolean) }));
  return {
    title: String(filename || '').replace(/\.[^.]+$/, '') || 'Cuộc họp mới',
    summary: keyPoints.slice(0, 3).map(item => item.text).join(' ') || 'Chưa đủ nội dung để tóm tắt.',
    keyPoints, decisions, actions, risks: [],
  };
}
function validateNotes(notes, transcript, coverage) {
  const knownTimes = new Set(transcript.map(row => String(row.time || '')));
  const validate = item => {
    const evidence = evidenceList(item.evidence).filter(time => knownTimes.has(time));
    return { ...item, evidence, confidence: evidence.length ? 'high' : 'low' };
  };
  const validated = {
    ...notes,
    keyPoints: notes.keyPoints.map(validate),
    decisions: notes.decisions.map(validate),
    actions: notes.actions.map(validate),
    risks: notes.risks.map(validate),
  };
  const lowConfidence = [...validated.decisions, ...validated.actions].filter(item => item.confidence === 'low').length;
  validated.coverage = {
    ...coverage,
    percent: coverage.totalChunks ? Math.round(coverage.processedChunks / Math.max(1, coverage.totalChunks) * 100) : 100,
    lowConfidence,
    warnings: [...coverage.warnings, ...(lowConfidence ? [`${lowConfidence} kết luận chưa có mốc bằng chứng hợp lệ.`] : [])],
  };
  return validated;
}
function transcriptText(rows) { return rows.map(row => `[${row.time}] ${row.speaker || 'Người nói'}: ${row.text}`).join('\n'); }

// ---------- GPT viết biên bản ----------
const templateInstructions = {
  meeting: 'Tạo biên bản chuẩn: mục tiêu, nội dung chính, quyết định và việc cần làm.',
  executive: 'Ưu tiên góc nhìn lãnh đạo: kết luận, tác động, rủi ro và quyết định cần phê duyệt.',
  project: 'Ưu tiên tiến độ, mốc bàn giao, vướng mắc, phụ thuộc, rủi ro và chủ sở hữu hành động.',
  sales: 'Ưu tiên nhu cầu khách hàng, pain points, phản đối, cam kết, cơ hội và bước tiếp theo.',
  interview: 'Tổ chức theo câu hỏi, câu trả lời, năng lực, dẫn chứng, điểm mạnh và vấn đề cần xác minh.',
  lecture: 'Tổ chức thành kiến thức cốt lõi, khái niệm, ví dụ, công thức và câu hỏi ôn tập.',
  brainstorm: 'Nhóm các ý tưởng theo chủ đề, đánh giá tiềm năng, rào cản và bước thử nghiệm tiếp theo.',
  custom: 'Tuân thủ ghi chú định hướng do người dùng cung cấp.',
};

const NOTES_SCHEMA = '{"title":"tiêu đề ngắn","summary":"tóm tắt điều hành 5-8 câu","keyPoints":[{"text":"điểm chính","evidence":["mốc thời gian"]}],"decisions":[{"text":"quyết định","context":"bối cảnh","evidence":["mốc thời gian"]}],"actions":[{"text":"việc cần làm","owner":"người phụ trách hoặc Chưa xác định","due":"thời hạn hoặc Chưa xác định","evidence":["mốc thời gian"]}],"risks":[{"text":"rủi ro","evidence":["mốc thời gian"]}]}';

async function chatJson(message, systemText, userText) {
  const body = JSON.stringify({
    model: message.summaryModel,
    messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
    response_format: { type: 'json_object' },
  });
  const data = await apiFetch('/chat/completions', { apiKey: message.apiKey, body });
  trackUsage(data);
  return extractJson(data.choices?.[0]?.message?.content || '');
}

async function summarize(message) {
  if (message.engine === 'gemini-claude') return summarizeClaude(message);
  const transcript = message.transcript || [];
  const fullText = transcriptText(transcript);
  const PART_LIMIT = 300000;
  const warnings = [];
  try {
    let sourceLabel = 'TRANSCRIPT ĐẦY ĐỦ';
    let sourceText = fullText;
    let totalChunks = 1;
    if (fullText.length > PART_LIMIT) {
      const parts = [];
      for (let offset = 0; offset < fullText.length; offset += PART_LIMIT) parts.push(fullText.slice(offset, offset + PART_LIMIT));
      totalChunks = parts.length;
      const extracted = [];
      for (let index = 0; index < parts.length; index += 1) {
        progress('llm-run', 5 + index / parts.length * 55, `GPT đang đọc phần ${index + 1}/${parts.length} của transcript…`);
        extracted.push(await chatJson(message,
          'Bạn là chuyên viên kiểm kê dữ kiện cuộc họp. Viết tiếng Việt, bám sát bằng chứng, không bịa. Trả về JSON.',
          `Trích xuất dữ kiện từ phần ${index + 1}/${parts.length} của transcript. Mỗi dữ kiện kèm evidence là mốc thời gian sao chép NGUYÊN VĂN từ đầu dòng transcript (trong ngoặc vuông). Trả về duy nhất JSON theo cấu trúc: ${NOTES_SCHEMA}\n\n${parts[index]}`));
      }
      sourceLabel = `HỒ SƠ DỮ KIỆN (trích từ toàn bộ ${parts.length} phần transcript)`;
      sourceText = JSON.stringify(extracted);
    }
    progress('llm-run', 65, 'GPT đang viết biên bản cuối…');
    const prompt = `Tạo biên bản cuộc họp từ ${sourceLabel} bên dưới. ${templateInstructions[message.template] || templateInstructions.meeting}
Ghi chú định hướng: ${message.context || 'Không có'}
Từ vựng riêng cần giữ đúng chính tả: ${message.vocabulary || 'Không có'}
Tệp hình ảnh tham chiếu (chỉ dùng tên tệp làm ngữ cảnh): ${(message.images || []).join(', ') || 'Không có'}
Quy tắc evidence: mỗi mục trong keyPoints, decisions, actions, risks phải kèm 1-3 mốc thời gian sao chép NGUYÊN VĂN từ transcript (chuỗi trong ngoặc vuông đầu dòng, ví dụ "03:15" hoặc "01:02:33"). Không tự chế mốc thời gian. Không bịa dữ kiện.
Tên file: ${message.filename}
Trả về duy nhất JSON theo cấu trúc: ${NOTES_SCHEMA}

${sourceLabel}:
${sourceText}`;
    const notes = normalizeNotes(await chatJson(message, 'Bạn là thư ký cuộc họp chuyên nghiệp. Viết tiếng Việt, chính xác, đầy đủ và không suy diễn. Trả về JSON.', prompt), message.filename);
    const validated = validateNotes(notes, transcript, { totalChunks, processedChunks: totalChunks, warnings });
    progress('llm-run', 100, 'Biên bản đã hoàn tất.');
    self.postMessage({ type: 'result', notes: validated, fallback: false, usage: { ...usageTotals } });
  } catch (error) {
    const notes = heuristicNotes(transcript, message.filename);
    const validated = validateNotes(notes, transcript, { totalChunks: 1, processedChunks: 1, warnings: [`Tóm tắt bằng GPT thất bại: ${error.message} — bên dưới là bản trích xuất thô, transcript vẫn đầy đủ.`] });
    progress('llm-run', 100, 'Đã dùng chế độ trích xuất thô.');
    self.postMessage({ type: 'result', notes: validated, fallback: true, usage: { ...usageTotals } });
  }
}

// ---------- Hỏi AI ----------
function relevantSegments(transcript, question, limit = 8) {
  const words = question.toLocaleLowerCase('vi').split(/\s+/u).filter(word => word.length > 2);
  return transcript.map(row => ({ row, score: words.reduce((score, word) => score + (row.text.toLocaleLowerCase('vi').includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score).filter(item => item.score > 0).slice(0, limit).map(item => item.row);
}

async function ask(message) {
  if (message.engine === 'gemini-claude') return askClaude(message);
  const transcript = message.transcript || [];
  try {
    const fullText = transcriptText(transcript);
    const contextText = fullText.length <= 150000 ? fullText : transcriptText(relevantSegments(transcript, message.question, 40));
    const body = JSON.stringify({
      model: message.summaryModel,
      messages: [
        { role: 'system', content: 'Bạn là trợ lý hỏi đáp cuộc họp. Trả lời ngắn gọn bằng tiếng Việt, chỉ dựa trên transcript được cung cấp. Nếu không đủ bằng chứng, nói rõ "Không tìm thấy trong bản ghi". Mỗi nhận định quan trọng kèm mốc thời gian dạng [MM:SS] hoặc [HH:MM:SS] sao chép từ transcript.' },
        { role: 'user', content: `CÂU HỎI: ${message.question}\n\nTRANSCRIPT:\n${contextText}` },
      ],
    });
    const data = await apiFetch('/chat/completions', { apiKey: message.apiKey, body });
    trackUsage(data);
    const answer = String(data.choices?.[0]?.message?.content || '').trim();
    const references = [...answer.matchAll(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g)].map(match => (Number(match[1]) || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    self.postMessage({ type: 'answer', answer: answer || 'Không tìm thấy trong bản ghi.', references: [...new Set(references)] });
  } catch (error) {
    self.postMessage({ type: 'answer', answer: `Không hỏi được GPT: ${error.message}`, references: [] });
  }
}

// ============ ENGINE 2: GEMINI (phiên âm) + CLAUDE (biên bản, sơ đồ) ============
const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'];
const CLAUDE_BASE = 'https://api.anthropic.com/v1';

function geminiErrorMessage(status, payload) {
  const detail = payload?.error?.message || '';
  if (status === 400 && /API key/iu.test(detail)) return 'API key Gemini không hợp lệ. Kiểm tra lại tại aistudio.google.com/apikey.';
  if (status === 403) return `API key Gemini không có quyền hoặc bị chặn. ${detail}`;
  if (status === 429) return 'Gemini đang giới hạn tốc độ (hết quota trong ngày hoặc gọi quá nhanh). Đợi một lúc rồi thử lại.';
  return detail || `Lỗi Gemini (HTTP ${status}).`;
}

async function geminiFetch(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    let response;
    try { response = await fetch(url, options); }
    catch { lastError = new Error('Không kết nối được tới Gemini. Kiểm tra mạng.'); continue; }
    if (response.ok) return response;
    const payload = await response.json().catch(() => null);
    const error = new Error(geminiErrorMessage(response.status, payload));
    error.status = response.status;
    if (response.status < 500 && response.status !== 429) throw error;
    lastError = error;
  }
  throw lastError || new Error('Không thể gọi Gemini.');
}

async function geminiUpload(blob, mimeType, apiKey, label) {
  const startResp = await geminiFetch(`${GEMINI_BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: label } }),
  });
  const uploadUrl = startResp.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini không trả về địa chỉ upload file.');
  const uploadResp = await geminiFetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
    body: blob,
  });
  let file = (await uploadResp.json()).file;
  for (let waited = 0; file?.state === 'PROCESSING' && waited < 300; waited += 3) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const poll = await geminiFetch(`${GEMINI_BASE}/v1beta/${file.name}?key=${apiKey}`);
    file = await poll.json();
  }
  if (file?.state !== 'ACTIVE') throw new Error(`Gemini chưa xử lý xong file âm thanh (trạng thái ${file?.state || 'không rõ'}).`);
  return file;
}

async function geminiGenerate(apiKey, parts, maxOutputTokens = 65536) {
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const resp = await geminiFetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens },
        }),
      });
      const data = await resp.json();
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts || []).map(part => part.text || '').join('');
      if (!text) throw new Error(candidate?.finishReason ? `Gemini dừng vì ${candidate.finishReason}.` : 'Gemini không trả về nội dung.');
      return { text, truncated: candidate?.finishReason === 'MAX_TOKENS' };
    } catch (error) {
      if (error.status === 404 || /not found|not supported|is not available/iu.test(error.message || '')) { lastError = error; continue; }
      throw error;
    }
  }
  throw lastError || new Error('Không tìm thấy model Gemini khả dụng với key này.');
}

async function transcribeGemini(message) {
  speakerNames.clear();
  const apiKey = message.geminiKey;
  const parts = message.uploadParts || [];
  if (!parts.length) throw new Error('Không có dữ liệu âm thanh để gửi tới Gemini.');

  const uploaded = [];
  for (let index = 0; index < parts.length; index += 1) {
    progress('asr-run', 2 + index / parts.length * 28, `Đang tải phần ${index + 1}/${parts.length} lên Gemini (${Math.round((parts[index].blob?.size || 0) / 1048576)} MB)…`);
    const file = await geminiUpload(parts[index].blob, parts[index].mimeType, apiKey, `part-${index + 1}`);
    uploaded.push({ offset: Number(parts[index].offset) || 0, uri: file.uri, mime: file.mimeType || parts[index].mimeType });
  }

  // File đơn quá dài: gọi nhiều lượt theo khung 60 phút trên cùng file; nhiều phần: gom ~6 phần (≈1 giờ)/lượt
  const jobs = [];
  const totalSeconds = Number(message.durationSeconds) || 0;
  if (uploaded.length === 1 && totalSeconds > 4500) {
    for (let t = 0; t < totalSeconds; t += 3600) jobs.push({ group: uploaded, range: [t, Math.min(totalSeconds, Math.ceil(t + 3600))] });
  } else {
    for (let index = 0; index < uploaded.length; index += 6) jobs.push({ group: uploaded.slice(index, index + 6), range: null });
  }

  const transcript = [];
  let speakerHint = '';
  for (let j = 0; j < jobs.length; j += 1) {
    const { group, range } = jobs[j];
    progress('asr-run', 32 + j / jobs.length * 62, `Gemini đang phiên âm ${jobs.length > 1 ? `lượt ${j + 1}/${jobs.length}` : 'toàn bộ bản ghi'}…`);
    const fileParts = group.map(item => ({ file_data: { file_uri: item.uri, mime_type: item.mime } }));
    const prompt = `Phiên âm ${group.length > 1 ? `${group.length} file âm thanh sau (là các phần LIÊN TIẾP của cùng một buổi ghi, theo đúng thứ tự)` : 'file âm thanh sau'} sang văn bản${message.language && message.language !== 'auto' ? ` (ngôn ngữ chính: ${message.language === 'vi' ? 'tiếng Việt' : message.language})` : ''}.
Yêu cầu:
- Tách người nói, dùng nhãn A, B, C… nhất quán trong toàn bộ buổi ghi.${speakerHint}
- Chia thành các đoạn ngắn theo lượt nói.
- "part" là số thứ tự file trong danh sách (bắt đầu từ 1); "start"/"end" là GIÂY tính trong file đó.${range ? `\n- CHỈ phiên âm đoạn từ giây ${range[0]} đến giây ${range[1]} của file; "start"/"end" vẫn tính theo mốc của cả file.` : ''}
- Từ vựng cần viết đúng chính tả: ${message.vocabulary || 'Không có'}.
Trả về DUY NHẤT JSON hợp lệ: {"segments":[{"part":1,"start":0.0,"end":4.5,"speaker":"A","text":"..."}]}`;
    const { text, truncated } = await geminiGenerate(apiKey, [...fileParts, { text: prompt }]);
    const data = extractJson(text);
    const segments = Array.isArray(data?.segments) ? data.segments : [];
    for (const segment of segments) {
      const local = group[Math.max(0, Math.min(group.length - 1, (Number(segment.part) || 1) - 1))];
      const start = local.offset + (Number(segment.start) || 0);
      const end = local.offset + (Number(segment.end) || 0);
      const line = String(segment.text || '').trim();
      if (line) transcript.push({ start, end: end > start ? end : start, time: formatClock(start), text: line, speaker: speakerLabel(segment.speaker) });
    }
    if (truncated) progress('asr-run', 32 + (j + 1) / jobs.length * 62, `⚠ Lượt ${j + 1} dài quá giới hạn, transcript có thể thiếu phần cuối.`);
    const seen = [...new Set(transcript.map(row => row.speaker))].filter(Boolean).join(', ');
    speakerHint = seen ? `\n- Các người nói đã xuất hiện ở phần trước: ${seen}. Nhận diện giọng và tiếp tục dùng đúng nhãn cũ.` : '';
  }

  transcript.sort((a, b) => a.start - b.start);
  progress('asr-run', 100, 'Transcript đã hoàn tất.');
  self.postMessage({ type: 'transcript', transcript });
}

async function claudeMessages(message, systemText, userText, maxTokens = 8192) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    let response;
    try {
      response = await fetch(`${CLAUDE_BASE}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': message.claudeKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: message.claudeModel || 'claude-sonnet-5',
          max_tokens: maxTokens,
          system: systemText,
          messages: [{ role: 'user', content: userText }],
        }),
      });
    } catch { lastError = new Error('Không kết nối được tới api.anthropic.com. Kiểm tra mạng.'); continue; }
    const data = await response.json().catch(() => null);
    if (response.ok) {
      usageTotals.inputTokens += Number(data?.usage?.input_tokens || 0);
      usageTotals.outputTokens += Number(data?.usage?.output_tokens || 0);
      if (data?.stop_reason === 'refusal') throw new Error('Claude từ chối xử lý nội dung này.');
      return (data?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    }
    const detail = data?.error?.message || '';
    const error = new Error(
      response.status === 401 ? 'API key Claude không đúng. Kiểm tra tại console.anthropic.com/settings/keys.'
        : response.status === 429 ? 'Claude đang giới hạn tốc độ. Đợi một phút rồi thử lại.'
        : response.status === 404 ? `Model Claude không khả dụng với key này: ${detail}`
        : detail || `Lỗi Claude (HTTP ${response.status}).`);
    if (response.status < 500 && response.status !== 429) throw error;
    lastError = error;
  }
  throw lastError || new Error('Không thể gọi Claude.');
}

const NOTES_SCHEMA_MM = NOTES_SCHEMA.slice(0, -1) + ',"mindmap":"mã Mermaid mindmap tiếng Việt: dòng đầu là chữ mindmap, dòng sau là node gốc dạng root((tiêu đề)), các nhánh là chủ đề chính, nhánh con là quyết định/việc/rủi ro quan trọng"}';

async function summarizeClaude(message) {
  const transcript = message.transcript || [];
  const fullText = transcriptText(transcript);
  const PART_LIMIT = 300000;
  const warnings = [];
  try {
    let sourceLabel = 'TRANSCRIPT ĐẦY ĐỦ';
    let sourceText = fullText;
    let totalChunks = 1;
    if (fullText.length > PART_LIMIT) {
      const pieces = [];
      for (let offset = 0; offset < fullText.length; offset += PART_LIMIT) pieces.push(fullText.slice(offset, offset + PART_LIMIT));
      totalChunks = pieces.length;
      const extracted = [];
      for (let index = 0; index < pieces.length; index += 1) {
        progress('llm-run', 5 + index / pieces.length * 55, `Claude đang đọc phần ${index + 1}/${pieces.length} của transcript…`);
        extracted.push(extractJson(await claudeMessages(message,
          'Bạn là chuyên viên kiểm kê dữ kiện cuộc họp. Viết tiếng Việt, bám sát bằng chứng, không bịa. Trả về duy nhất JSON.',
          `Trích xuất dữ kiện từ phần ${index + 1}/${pieces.length} của transcript. Mỗi dữ kiện kèm evidence là mốc thời gian sao chép NGUYÊN VĂN từ đầu dòng transcript (trong ngoặc vuông). Trả về duy nhất JSON theo cấu trúc: ${NOTES_SCHEMA}\n\n${pieces[index]}`)));
      }
      sourceLabel = `HỒ SƠ DỮ KIỆN (trích từ toàn bộ ${pieces.length} phần transcript)`;
      sourceText = JSON.stringify(extracted);
    }
    progress('llm-run', 65, 'Claude đang viết biên bản và vẽ sơ đồ…');
    const prompt = `Tạo biên bản cuộc họp từ ${sourceLabel} bên dưới. ${templateInstructions[message.template] || templateInstructions.meeting}
Ghi chú định hướng: ${message.context || 'Không có'}
Từ vựng riêng cần giữ đúng chính tả: ${message.vocabulary || 'Không có'}
Quy tắc evidence: mỗi mục trong keyPoints, decisions, actions, risks phải kèm 1-3 mốc thời gian sao chép NGUYÊN VĂN từ transcript (chuỗi trong ngoặc vuông đầu dòng, ví dụ "03:15" hoặc "01:02:33"). Không tự chế mốc thời gian. Không bịa dữ kiện.
Quy tắc mindmap: viết mã Mermaid hợp lệ, thụt lề 2 dấu cách mỗi cấp, mỗi node một dòng, không dùng ký tự đặc biệt ()[]{} trong tên node (trừ node gốc root((...))), tối đa 3 cấp và ~25 node.
Tên file: ${message.filename}
Trả về duy nhất JSON hợp lệ theo cấu trúc: ${NOTES_SCHEMA_MM}

${sourceLabel}:
${sourceText}`;
    const parsed = extractJson(await claudeMessages(message, 'Bạn là thư ký cuộc họp chuyên nghiệp. Viết tiếng Việt, chính xác, đầy đủ và không suy diễn. Trả về duy nhất JSON hợp lệ.', prompt, 8192));
    const notes = normalizeNotes(parsed, message.filename);
    notes.mindmap = typeof parsed.mindmap === 'string' ? parsed.mindmap.trim() : '';
    const validated = validateNotes(notes, transcript, { totalChunks, processedChunks: totalChunks, warnings });
    progress('llm-run', 100, 'Biên bản đã hoàn tất.');
    self.postMessage({ type: 'result', notes: validated, fallback: false, usage: { ...usageTotals } });
  } catch (error) {
    const notes = heuristicNotes(transcript, message.filename);
    const validated = validateNotes(notes, transcript, { totalChunks: 1, processedChunks: 1, warnings: [`Viết biên bản bằng Claude thất bại: ${error.message} — bên dưới là bản trích xuất thô, transcript vẫn đầy đủ.`] });
    progress('llm-run', 100, 'Đã dùng chế độ trích xuất thô.');
    self.postMessage({ type: 'result', notes: validated, fallback: true, usage: { ...usageTotals } });
  }
}

async function askClaude(message) {
  try {
    const transcript = message.transcript || [];
    const fullText = transcriptText(transcript);
    const contextText = fullText.length <= 150000 ? fullText : transcriptText(relevantSegments(transcript, message.question, 40));
    const answer = (await claudeMessages(message,
      'Bạn là trợ lý hỏi đáp cuộc họp. Trả lời ngắn gọn bằng tiếng Việt, chỉ dựa trên transcript được cung cấp. Nếu không đủ bằng chứng, nói rõ "Không tìm thấy trong bản ghi". Mỗi nhận định quan trọng kèm mốc thời gian dạng [MM:SS] hoặc [HH:MM:SS] sao chép từ transcript.',
      `CÂU HỎI: ${message.question}\n\nTRANSCRIPT:\n${contextText}`, 2048)).trim();
    const references = [...answer.matchAll(/\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g)].map(match => (Number(match[1]) || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    self.postMessage({ type: 'answer', answer: answer || 'Không tìm thấy trong bản ghi.', references: [...new Set(references)] });
  } catch (error) {
    self.postMessage({ type: 'answer', answer: `Không hỏi được Claude: ${error.message}`, references: [] });
  }
}

self.onmessage = async event => {
  try {
    if (event.data?.type === 'enterprise-transcribe-large') await transcribeEnterpriseLarge(event.data);
    if (event.data?.type === 'transcribe') await transcribe(event.data);
    if (event.data?.type === 'summarize') await summarize(event.data);
    if (event.data?.type === 'ask') await ask(event.data);
  } catch (error) {
    self.postMessage({ type: 'error', error: error.message || 'Không thể xử lý qua OpenAI.' });
  }
};
