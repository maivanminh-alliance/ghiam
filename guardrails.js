// MeetingMind Enterprise V3 — ASR Guardrails engine (07_ASR_GUARDRAILS.md + 15_ASR_ANOMALY_RULES.json)
// Module thuần, dùng chung cho app.js (UI) và ai-worker.js (pipeline).

export const SEGMENT_STATUS = ['raw', 'quarantined', 'rescue_pending', 'rescued_supported', 'human_review_required', 'verified', 'rejected'];

export function compileRules(rules) {
  const compiled = { ...rules };
  compiled.domainRegexes = (rules.domainAnomalyPatterns || []).map(pattern => ({
    id: pattern.id,
    action: pattern.action,
    regex: new RegExp(pattern.regex, pattern.caseInsensitive ? 'iu' : 'u'),
  }));
  compiled.highRiskRegexes = (rules.highRiskPatterns || []).map(pattern => new RegExp(pattern, 'iu'));
  return compiled;
}

function normalizeForCompare(text) {
  return String(text || '').toLocaleLowerCase('vi').replace(/[.,!?…:;"'’]/gu, '').replace(/\s+/gu, ' ').trim();
}

export function textSimilarity(a, b) {
  const wordsA = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (!wordsA.size || !wordsB.size) return 0;
  let common = 0;
  for (const word of wordsA) if (wordsB.has(word)) common += 1;
  return common / Math.max(wordsA.size, wordsB.size);
}

export function isHighRisk(text, compiledRules) {
  return (compiledRules.highRiskRegexes || []).some(regex => regex.test(text || ''));
}

// Ghép transcript nhiều phần: sắp theo start, loại trùng vùng overlap giữa các phần
export function dedupeOverlap(transcript) {
  const sorted = [...transcript].sort((a, b) => a.start - b.start);
  const kept = [];
  for (const row of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && row.start < prev.end - 0.5 && textSimilarity(prev.text, row.text) >= 0.8) continue; // trùng vùng overlap
    kept.push(row);
  }
  return kept;
}

// Phát hiện lặp trong 1 segment: cụm >=3 từ lặp >=3 lần, hoặc 1 từ/cụm chiếm >60%
function internalRepetition(text) {
  const words = normalizeForCompare(text).split(' ').filter(Boolean);
  if (words.length < 9) return false;
  const counts = new Map();
  for (let i = 0; i + 2 < words.length; i += 1) {
    const phrase = words.slice(i, i + 3).join(' ');
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  for (const [, count] of counts) if (count >= 3) return true;
  const wordCounts = new Map();
  for (const word of words) wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  const top = Math.max(...wordCounts.values());
  return top / words.length > 0.6;
}

/**
 * Chạy toàn bộ detector trên transcript (đã ghép, timestamp toàn cục).
 * Trả về { segments (kèm status/anomaly), anomalies[], metrics }.
 * KHÔNG xóa gì — chỉ đánh dấu (prohibitedActions: delete_raw_transcript, auto_delete_by_keyword_only).
 */
export function detectAnomalies(transcript, compiledRules, durationSeconds = 0) {
  const t = compiledRules.thresholds || {};
  const segments = transcript.map((row, index) => ({ ...row, index, status: 'raw', anomalies: [] }));
  const anomalies = [];
  const flag = (segment, ruleId, detail, wantRescue) => {
    if (!segment.anomalies.includes(ruleId)) segment.anomalies.push(ruleId);
    if (segment.status === 'raw') segment.status = wantRescue ? 'rescue_pending' : 'quarantined';
    anomalies.push({ index: segment.index, ruleId, detail, start: segment.start, end: segment.end, text: segment.text, wantRescue: Boolean(wantRescue) });
  };

  // 1. domain_mismatch (quarantine_and_rescue — không xóa theo từ khóa)
  for (const segment of segments) {
    for (const rule of compiledRules.domainRegexes || []) {
      if (rule.regex.test(segment.text)) flag(segment, `domain:${rule.id}`, 'Câu ngoài ngữ cảnh (quảng cáo/giải trí)', rule.action === 'quarantine_and_rescue');
    }
  }

  // 2. exact_duplicate_across_distant_timestamps
  const byText = new Map();
  for (const segment of segments) {
    const key = normalizeForCompare(segment.text);
    if (key.length < (t.exactDuplicateLongTextMinimumCharacters || 24)) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(segment);
  }
  for (const [, group] of byText) {
    if (group.length < (t.exactDuplicateMinimumCount || 3)) continue;
    const spread = group[group.length - 1].start - group[0].start;
    if (spread > 60) group.forEach(segment => flag(segment, 'exact_duplicate', `Câu giống hệt xuất hiện ${group.length} lần ở các mốc cách xa`, true));
  }

  // 3. near_duplicate_repetition: >=3 segment liên tiếp similarity cao, hoặc lặp nội bộ
  for (let i = 0; i < segments.length; i += 1) {
    if (internalRepetition(segments[i].text)) flag(segments[i], 'near_duplicate_repetition', 'Lặp cụm từ trong segment', true);
    if (i >= 2 && textSimilarity(segments[i].text, segments[i - 1].text) >= 0.85 && textSimilarity(segments[i - 1].text, segments[i - 2].text) >= 0.85) {
      [segments[i], segments[i - 1], segments[i - 2]].forEach(segment => flag(segment, 'near_duplicate_repetition', 'Chuỗi segment liên tiếp gần giống nhau', true));
    }
  }

  // 4. long_low_information_segment
  for (const segment of segments) {
    const seconds = (segment.end || segment.start) - segment.start;
    const uniqueWords = new Set(normalizeForCompare(segment.text).split(' ').filter(Boolean));
    if (seconds > (t.longSegmentSeconds || 20) && uniqueWords.size <= 8) flag(segment, 'long_low_information_segment', `Segment ${Math.round(seconds)}s nhưng rất ít thông tin`, true);
  }

  // 5. confidence_below_threshold (chỉ khi provider trả confidence)
  for (const segment of segments) {
    if (typeof segment.confidence === 'number' && segment.confidence < (t.segmentLowConfidence || 0.6)) {
      flag(segment, 'confidence_below_threshold', `Confidence ${segment.confidence.toFixed(2)} < ${t.segmentLowConfidence || 0.6}`, true);
    }
  }

  // 6. timestamp_gap + speaker_missing (không quarantine — chỉ cảnh báo/queue)
  const gaps = [];
  for (let i = 1; i < segments.length; i += 1) {
    const gap = segments[i].start - (segments[i - 1].end || segments[i - 1].start);
    if (gap > 30) gaps.push({ from: segments[i - 1].end, to: segments[i].start, seconds: gap });
  }

  // Metrics
  const flagged = segments.filter(segment => segment.status !== 'raw');
  const anomalySeconds = flagged.reduce((sum, segment) => sum + Math.max(0, (segment.end || segment.start) - segment.start), 0);
  const lowConfidence = segments.filter(segment => typeof segment.confidence === 'number' && segment.confidence < (t.segmentLowConfidence || 0.6));
  const speakerMissing = segments.filter(segment => !segment.speaker);
  const gapSeconds = gaps.reduce((sum, gap) => sum + gap.seconds, 0);
  const coveredSeconds = Math.max(0, (durationSeconds || (segments.at(-1)?.end || 0)) - gapSeconds);
  const metrics = {
    totalSegments: segments.length,
    anomalySegments: flagged.length,
    anomalySeconds: Math.round(anomalySeconds * 10) / 10,
    anomalyRate: durationSeconds ? anomalySeconds / durationSeconds : 0,
    lowConfidenceRate: segments.length ? lowConfidence.length / segments.length : 0,
    speakerCoverage: segments.length ? (segments.length - speakerMissing.length) / segments.length : 0,
    audioCoverage: durationSeconds ? Math.min(1, coveredSeconds / durationSeconds) : 1,
    gaps,
  };
  return { segments, anomalies, metrics };
}

// Quyết định trạng thái sau chuỗi cứu hộ (07: so sánh transcript, chỉ giữ phần đồng thuận; mâu thuẫn → human review)
export function decideRescueStatus(originalText, rescueTexts, compiledRules) {
  const valid = (rescueTexts || []).filter(text => String(text || '').trim());
  if (!valid.length) return { status: 'human_review_required', supportedText: '', reason: 'Cứu hộ không trả về nội dung' };
  const stillAnomalous = valid.every(text => (compiledRules.domainRegexes || []).some(rule => rule.regex.test(text)));
  if (stillAnomalous) return { status: 'human_review_required', supportedText: '', reason: 'Tái phiên âm vẫn ra nội dung bất thường' };
  if (valid.length >= 2 && textSimilarity(valid[0], valid[1]) >= 0.7) {
    return { status: 'rescued_supported', supportedText: valid[0], reason: 'Hai lần tái phiên âm đồng thuận' };
  }
  const clean = valid.find(text => !(compiledRules.domainRegexes || []).some(rule => rule.regex.test(text)));
  if (clean && textSimilarity(clean, originalText) < 0.5) {
    return { status: 'human_review_required', supportedText: clean, reason: 'Cứu hộ ra nội dung khác nhưng chưa đủ đồng thuận' };
  }
  return { status: 'human_review_required', supportedText: clean || '', reason: 'Kết quả cứu hộ chưa đủ tin cậy' };
}

// Gợi ý chuẩn hóa có kiểm soát — KHÔNG tự sửa, chỉ tạo mục xác minh (B3849 → B38-B49, biến thể MEP…)
export function buildNormalizationSuggestions(segments) {
  const suggestions = [];
  const unitCodeRegex = /\b([ABC])(\d{3,4})\b/gu;
  const mepVariant = /\b(MVP|MPP|MAP)\b/gu;
  for (const segment of segments) {
    for (const match of String(segment.text || '').matchAll(unitCodeRegex)) {
      const digits = match[2];
      if (digits.length === 4) {
        const suggestion = `${match[1]}${digits.slice(0, 2)}-${match[1]}${digits.slice(2)}`;
        suggestions.push({ type: 'unit_code', index: segment.index, start: segment.start, originalText: match[0], normalizedText: suggestion, reason: 'Mã căn nghi bị dính (07_ASR_GUARDRAILS)', confidence: 'medium', source: 'rule:unit_code' });
      }
    }
    for (const match of String(segment.text || '').matchAll(mepVariant)) {
      suggestions.push({ type: 'name_term', index: segment.index, start: segment.start, originalText: match[0], normalizedText: 'MEP', reason: 'Biến thể nghi của MEP — không tự coi là một đơn vị, cần xác nhận', confidence: 'low', source: 'rule:mep_variant' });
    }
  }
  return suggestions;
}

// Hàng chờ xác minh nhóm theo 07: tên/đơn vị, mã căn, số liệu, lặp, ngoài ngữ cảnh, speaker
export function buildVerificationQueue(segments, suggestions, compiledRules) {
  const queue = [];
  let id = 0;
  const push = (group, item) => queue.push({ id: `vq${id += 1}`, group, resolved: false, ...item });
  for (const suggestion of suggestions) {
    push(suggestion.type === 'unit_code' ? 'Mã căn / hạng mục' : 'Tên người / đơn vị', { ...suggestion, kind: 'normalize' });
  }
  for (const segment of segments) {
    if (segment.status !== 'raw' && segment.status !== 'verified') {
      const group = segment.anomalies.some(anomaly => anomaly.startsWith('domain:')) ? 'Câu ngoài ngữ cảnh' : 'Câu lặp / bất thường';
      push(group, { kind: 'anomaly', index: segment.index, start: segment.start, end: segment.end, originalText: segment.text, status: segment.status, anomalies: segment.anomalies, rescue: segment.rescue || null });
    } else if (isHighRisk(segment.text, compiledRules) && (typeof segment.confidence !== 'number' || segment.confidence < (compiledRules.thresholds?.highRiskFactMinimumConfidence || 0.8))) {
      push('Số liệu / tiền / ngày / cam kết', { kind: 'high_risk_fact', index: segment.index, start: segment.start, end: segment.end, originalText: segment.text, confidence: segment.confidence ?? null });
    }
    if (!segment.speaker) push('Speaker chưa xác định', { kind: 'speaker', index: segment.index, start: segment.start, originalText: segment.text });
  }
  return queue;
}

// Quality gate (07 + 15): điều kiện phát hành
export function computeGate(metrics, queue, notes, options = {}) {
  const t = options.thresholds || {};
  const warnings = [];
  const unresolvedQueue = queue.filter(item => !item.resolved);
  const unresolvedAnomalies = unresolvedQueue.filter(item => item.kind === 'anomaly');
  const unresolvedCritical = unresolvedQueue.filter(item => item.kind === 'high_risk_fact' || item.kind === 'normalize');
  if (options.transcriptEmpty) warnings.push('Transcript rỗng — không thể phát hành.');
  if (options.analysisFallback) warnings.push('Bước phân tích AI thất bại, đang dùng trích xuất thô.');
  if (metrics.audioCoverage < (t.minimumAudioCoverageForRelease || 0.98)) warnings.push(`Audio coverage ${(metrics.audioCoverage * 100).toFixed(1)}% < ${((t.minimumAudioCoverageForRelease || 0.98) * 100)}%.`);
  if (metrics.anomalyRate > (t.maximumUnresolvedAnomalyRateForRelease || 0.03) && unresolvedAnomalies.length) warnings.push(`Thời lượng bất thường chưa xử lý ${(metrics.anomalyRate * 100).toFixed(1)}% > 3%.`);
  if (unresolvedAnomalies.length) warnings.push(`${unresolvedAnomalies.length} đoạn cách ly chưa được xác minh.`);
  if (unresolvedCritical.length) warnings.push(`${unresolvedCritical.length} số liệu/tên/mã quan trọng chưa xác minh.`);
  for (const gap of metrics.gaps || []) warnings.push(`Khoảng trống ${Math.round(gap.seconds)}s quanh ${Math.round(gap.from)}s chưa có cảnh báo nội dung.`);
  const releasable = !options.transcriptEmpty && !options.analysisFallback && unresolvedAnomalies.length === 0 && unresolvedCritical.length === 0 && metrics.audioCoverage >= (t.minimumAudioCoverageForRelease || 0.98);
  return { releasable, warnings, unresolvedCount: unresolvedQueue.length };
}

// Chặn quyết định/action tham chiếu segment bất thường chưa xác minh (prohibitedActions)
export function stripUnverifiedEvidence(items, segments) {
  const blockedTimes = new Set(segments.filter(segment => segment.status !== 'raw' && segment.status !== 'verified' && segment.status !== 'rescued_supported').map(segment => segment.time));
  const kept = []; const blocked = [];
  for (const item of items || []) {
    const usesBlocked = (item.evidence || []).some(time => blockedTimes.has(time));
    if (usesBlocked) blocked.push(item); else kept.push(item);
  }
  return { kept, blocked };
}
