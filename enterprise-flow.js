// MeetingMind Enterprise V3.1 — luồng backend hai bước (17_HANDOFF + 16_ARCHITECTURE + 19_ORG)
// Audio → POST /transcribe → sửa tên speaker → POST /analyze-transcript → bản nháp → duyệt → xuất.
// Không đặt API key ở frontend; chỉ gọi backend production đã deploy.

export const BACKEND_BASE = 'https://meetingmind-openai-backend.meetingmind-minh.workers.dev';
export const ORGANIZATIONS = ['Alliance', 'G.S Việt Nam'];
export const ORG_HINTS = {
  'Alliance': 'Quản lý dự án, công trường, kỹ thuật, tiến độ, vật tư và nhà thầu.',
  'G.S Việt Nam': 'Nhân sự chiến lược, cơ cấu, KPI, chính sách và phối hợp liên phòng ban.',
};

export async function checkHealth() {
  const response = await fetch(`${BACKEND_BASE}/health`, { method: 'GET' });
  if (!response.ok) throw new Error(`Backend /health trả HTTP ${response.status}.`);
  return response.json();
}

// Kiểm tra cấu hình bắt buộc theo file 20; trả {ok, reason} để UI hiển thị.
export function validateHealth(health) {
  if (!health) return { ok: false, reason: 'Không đọc được /health.' };
  if (!health.openaiConfigured) return { ok: false, reason: 'Backend chưa cài OpenAI key (openaiConfigured=false). Chạy "Cài OpenAI Key an toàn.command".' };
  if (health.schemaVersion !== '3.1') return { ok: false, reason: `Schema backend là ${health.schemaVersion}, cần 3.1. Chạy "Deploy MeetingMind GPT56.command".` };
  if (health.analysisModel !== 'gpt-5.6-sol') return { ok: false, reason: `analysisModel là ${health.analysisModel}, cần gpt-5.6-sol.` };
  if (health.speakerWorkflow !== 'manual_rename_before_analysis') return { ok: false, reason: 'speakerWorkflow chưa đúng manual_rename_before_analysis.' };
  return { ok: true, reason: '' };
}

async function backendJson(path, options, retries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
    let response;
    try { response = await fetch(`${BACKEND_BASE}${path}`, options); }
    catch { lastError = new Error('Không kết nối được tới backend. Kiểm tra mạng.'); continue; }
    const payload = await response.json().catch(() => null);
    if (response.ok) return payload;
    const detail = payload?.error || payload?.message || '';
    const error = new Error(detail ? String(detail).slice(0, 300) : `Lỗi backend (HTTP ${response.status}).`);
    error.status = response.status;
    error.documentStatus = payload?.documentStatus;
    if (response.status < 500 && response.status !== 429) throw error;
    lastError = error;
  }
  throw lastError || new Error('Không thể gọi backend.');
}

// Bước 1: phiên âm + tách speaker. field bắt buộc: file. KHÔNG gửi glossary/initial prompt (07_GUARDRAILS).
export async function transcribeFile(file) {
  const form = new FormData();
  form.append('file', file, file.name || 'audio.m4a');
  const data = await backendJson('/transcribe', { method: 'POST', body: form });
  const transcript = Array.isArray(data?.transcript) ? data.transcript : [];
  return { transcript, documentStatus: data?.documentStatus || 'speaker_review', raw: data };
}

// Bước 2: gửi TOÀN BỘ transcript đã xác nhận tên + speakerMap + organization.
export async function analyzeTranscript({ filename, organization, transcript, speakerMap }) {
  if (!ORGANIZATIONS.includes(organization)) throw new Error(`Công ty không hợp lệ: ${organization}.`);
  const body = JSON.stringify({ filename, organization, transcript, speakerMap: speakerMap || {} });
  return backendJson('/analyze-transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

// Cứu hộ đoạn nghi ngờ: cắt audio gốc padding 5s → POST /rescue. KHÔNG ghi đè raw (16_ARCHITECTURE).
export async function rescueSegment(fileBlob, offsetSeconds) {
  const form = new FormData();
  form.append('file', fileBlob, 'rescue.wav');
  form.append('offsetSeconds', String(offsetSeconds));
  return backendJson('/rescue', { method: 'POST', body: form });
}

// Danh sách nhãn speaker duy nhất kèm vài câu mẫu có timestamp (không tạo voiceprint).
export function uniqueSpeakers(transcript) {
  const map = new Map();
  for (const row of transcript) {
    const label = row.originalSpeaker || row.speaker || 'SPEAKER_00';
    if (!map.has(label)) map.set(label, { label, current: row.speaker || label, samples: [] });
    const entry = map.get(label);
    if (entry.samples.length < 3 && String(row.text || '').trim()) entry.samples.push({ time: row.time, start: row.start, text: row.text });
  }
  return [...map.values()];
}

// Áp speakerMap: cập nhật toàn bộ segment mang nhãn đó, giữ originalSpeaker để audit/undo.
export function applySpeakerMap(transcript, speakerMap) {
  return transcript.map(row => {
    const original = row.originalSpeaker || row.speaker;
    const mapped = speakerMap[original];
    return { ...row, originalSpeaker: original, speaker: mapped && mapped.trim() ? mapped.trim() : (row.speaker || original) };
  });
}

// Backend trả evidence dạng chuỗi: "00:05 — Tên: ..." hoặc "[00:05–00:12] Tên: ...". Lấy giây của mốc đầu.
export function parseEvidenceSeconds(evidence) {
  const text = Array.isArray(evidence) ? (evidence[0] || '') : String(evidence || '');
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return 0;
  if (match[3]) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number(match[1]) * 60 + Number(match[2]);
}
export function evidenceLabel(evidence) {
  const text = Array.isArray(evidence) ? (evidence[0] || '') : String(evidence || '');
  const match = text.match(/\d{1,2}:\d{2}(?::\d{2})?/);
  return match ? match[0] : '';
}
