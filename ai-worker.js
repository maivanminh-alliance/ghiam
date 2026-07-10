import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

const whisperModels = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

const summaryModel = 'onnx-community/Qwen2.5-0.5B-Instruct';
let transcriber = null;
let generator = null;

function progress(phase, value, detail = '') {
  self.postMessage({ type: 'progress', phase, value: Math.max(0, Math.min(100, Number(value) || 0)), detail });
}

function downloadCallback(phase) {
  return event => {
    if (event.status === 'progress') progress(phase, event.progress || 0, event.file || 'Đang tải mô hình…');
    if (event.status === 'ready') progress(phase, 100, 'Mô hình đã sẵn sàng.');
  };
}

async function loadTranscriber(quality, webgpu) {
  const model = whisperModels[quality] || whisperModels.tiny;
  const gpuOptions = { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, progress_callback: downloadCallback('asr-download') };
  const cpuOptions = { device: 'wasm', dtype: 'q8', progress_callback: downloadCallback('asr-download') };
  try {
    transcriber = await pipeline('automatic-speech-recognition', model, webgpu ? gpuOptions : cpuOptions);
  } catch (error) {
    if (!webgpu) throw error;
    progress('asr-download', 0, 'WebGPU không tương thích, đang chuyển sang WASM…');
    transcriber = await pipeline('automatic-speech-recognition', model, cpuOptions);
  }
}

async function transcribe(message) {
  await loadTranscriber(message.quality, message.webgpu);
  progress('asr-run', 4, 'Mô hình đang nghe bản ghi…');
  const sampleRate = 16000;
  const segmentSamples = sampleRate * 10 * 60;
  const totalSegments = Math.max(1, Math.ceil(message.audio.length / segmentSamples));
  const transcript = [];
  for (let index = 0; index < totalSegments; index += 1) {
    const startSample = index * segmentSamples;
    const endSample = Math.min(message.audio.length, startSample + segmentSamples);
    const offsetSeconds = startSample / sampleRate;
    const options = {
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    if (message.language && message.language !== 'auto') options.language = message.language;
    progress('asr-run', 5 + index / totalSegments * 90, `Đang nghe phần ${index + 1}/${totalSegments} (${formatClock(offsetSeconds)}–${formatClock(endSample / sampleRate)})…`);
    const output = await transcriber(message.audio.slice(startSample, endSample), options);
    const chunks = output.chunks || [];
    if (chunks.length) {
      transcript.push(...chunks.map(chunk => {
        const start = offsetSeconds + (Number(chunk.timestamp?.[0]) || 0);
        const end = offsetSeconds + (Number(chunk.timestamp?.[1]) || 0);
        return { start, end, time: formatClock(start), text: String(chunk.text || '').trim() };
      }).filter(row => row.text));
    } else if (String(output.text || '').trim()) {
      transcript.push({ start: offsetSeconds, end: endSample / sampleRate, time: formatClock(offsetSeconds), text: String(output.text).trim() });
    }
  }
  await transcriber.dispose();
  transcriber = null;
  progress('asr-run', 100, 'Transcript đã hoàn tất.');
  self.postMessage({ type: 'transcript', transcript });
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/giu, '').replace(/```/gu, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI không tạo được JSON.');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function list(value, limit = 20) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function evidenceList(value) {
  return [...new Set(list(value, 8).map(item => String(item || '').replace(/[\[\]]/g, '').trim()).filter(Boolean))];
}

function normalizeFactItem(item, extras = {}) {
  if (typeof item === 'string') return { text: item, evidence: [], ...extras };
  return {
    text: String(item?.text || '').trim(),
    evidence: evidenceList(item?.evidence),
    ...extras,
    ...Object.fromEntries(Object.keys(extras).map(key => [key, String(item?.[key] || extras[key])])),
  };
}

function normalizeFactCard(value = {}) {
  return {
    overview: String(value.overview || value.summary || '').trim(),
    topics: list(value.topics, 12).map(item => normalizeFactItem(item)).filter(item => item.text),
    decisions: list(value.decisions, 16).map(item => normalizeFactItem(item, { context: '' })).filter(item => item.text),
    actions: list(value.actions, 20).map(item => normalizeFactItem(item, { owner: 'Chưa xác định', due: 'Chưa xác định' })).filter(item => item.text),
    risks: list(value.risks, 12).map(item => normalizeFactItem(item)).filter(item => item.text),
    questions: list(value.questions, 12).map(item => normalizeFactItem(item)).filter(item => item.text),
  };
}

function normalizeNotes(value, filename) {
  const notes = value && typeof value === 'object' ? value : {};
  return {
    title: String(notes.title || filename.replace(/\.[^.]+$/, '') || 'Cuộc họp mới'),
    summary: String(notes.summary || 'Chưa xác định.'),
    keyPoints: list(notes.keyPoints, 12).map(item => typeof item === 'string' ? { text: item, evidence: [] } : normalizeFactItem(item)).filter(item => item.text),
    decisions: list(notes.decisions, 16).map(item => normalizeFactItem(item, { context: '' })).filter(item => item.text),
    actions: list(notes.actions, 20).map(item => normalizeFactItem(item, { owner: 'Chưa xác định', due: 'Chưa xác định' })).filter(item => item.text),
    risks: list(notes.risks, 12).map(item => normalizeFactItem(item)).filter(item => item.text),
  };
}

function heuristicNotes(transcript, filename) {
  const sentences = transcript.map(row => row.text.trim()).filter(text => text.length > 18);
  const unique = [...new Set(sentences)];
  const evidenceFor = text => transcript.find(row => row.text.trim() === text)?.time;
  const decisions = unique.filter(text => /(chốt|thống nhất|quyết định|đồng ý|phê duyệt)/iu.test(text)).slice(0, 10).map(text => ({ text, context: 'Trích từ transcript', evidence: [evidenceFor(text)].filter(Boolean) }));
  const actionPattern = /(sẽ|cần|phụ trách|hoàn thành|gửi|kiểm tra|cập nhật|chuẩn bị|thực hiện)/iu;
  const actions = unique.filter(text => actionPattern.test(text)).slice(0, 12).map(text => ({
    text,
    owner: 'Chưa xác định',
    due: text.match(/(?:ngày\s*)?\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?/u)?.[0] || 'Chưa xác định',
    evidence: [evidenceFor(text)].filter(Boolean),
  }));
  const keyPoints = unique.slice(0, 7).map(text => ({ text, evidence: [evidenceFor(text)].filter(Boolean) }));
  return {
    title: filename.replace(/\.[^.]+$/, '') || 'Cuộc họp mới',
    summary: keyPoints.slice(0, 3).map(item => item.text).join(' ') || 'Chưa đủ nội dung để tóm tắt.',
    keyPoints,
    decisions,
    actions,
    risks: [],
  };
}

function chunkTranscript(transcript, maxCharacters = 6500, maxSeconds = 8 * 60) {
  const chunks = [];
  let current = [];
  let characters = 0;
  let chunkStart = 0;
  for (const row of transcript) {
    const lineLength = String(row.text || '').length + 24;
    const elapsed = current.length ? (Number(row.end || row.start) || 0) - chunkStart : 0;
    if (current.length && (characters + lineLength > maxCharacters || elapsed > maxSeconds)) {
      chunks.push(current);
      current = [];
      characters = 0;
    }
    if (!current.length) chunkStart = Number(row.start) || 0;
    current.push(row);
    characters += lineLength;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function transcriptText(rows) {
  return rows.map(row => `[${row.time}] ${row.speaker || 'Người nói'}: ${row.text}`).join('\n');
}

function heuristicFactCard(rows) {
  const card = heuristicNotes(rows, '');
  return normalizeFactCard({
    overview: card.summary,
    topics: card.keyPoints,
    decisions: card.decisions,
    actions: card.actions,
  });
}

function combineCards(cards) {
  const uniqueItems = (key, limit) => {
    const seen = new Set();
    return cards.flatMap(card => card[key] || []).filter(item => {
      const fingerprint = String(item.text || '').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
      if (!fingerprint || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    }).slice(0, limit);
  };
  return normalizeFactCard({
    overview: cards.map(card => card.overview).filter(Boolean).join(' '),
    topics: uniqueItems('topics', 18),
    decisions: uniqueItems('decisions', 22),
    actions: uniqueItems('actions', 26),
    risks: uniqueItems('risks', 16),
    questions: uniqueItems('questions', 16),
  });
}

function generatedContent(output) {
  const generated = output?.[0]?.generated_text;
  return Array.isArray(generated) ? generated.at(-1)?.content : String(generated || '');
}

async function loadGenerator(webgpu) {
  if (generator) return generator;
  const options = {
    device: webgpu ? 'webgpu' : 'wasm',
    dtype: 'q4',
    progress_callback: downloadCallback('llm-download'),
  };
  try {
    generator = await pipeline('text-generation', summaryModel, options);
  } catch (error) {
    if (!webgpu) throw error;
    generator = await pipeline('text-generation', summaryModel, { ...options, device: 'wasm' });
  }
}

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

async function analyzeChunk(rows, message, index, total) {
  const start = rows[0]?.time || '00:00';
  const end = rows.at(-1)?.time || start;
  const prompt = `Đọc TOÀN BỘ khối transcript ${index + 1}/${total} (${start}-${end}). Chỉ ghi nhận dữ kiện xuất hiện trong khối, không suy diễn. Mỗi dữ kiện phải giữ mốc thời gian gần nhất.
Ngữ cảnh: ${message.context || 'Không có'}
Từ vựng cần giữ đúng: ${message.vocabulary || 'Không có'}
Trả về duy nhất JSON:
{"overview":"nội dung khối","topics":[{"text":"chủ đề","evidence":["MM:SS"]}],"decisions":[{"text":"quyết định rõ ràng","context":"bối cảnh","evidence":["MM:SS"]}],"actions":[{"text":"việc cần làm","owner":"người phụ trách hoặc Chưa xác định","due":"thời hạn hoặc Chưa xác định","evidence":["MM:SS"]}],"risks":[{"text":"rủi ro/vướng mắc","evidence":["MM:SS"]}],"questions":[{"text":"vấn đề chưa kết luận","evidence":["MM:SS"]}]}

TRANSCRIPT KHỐI ${index + 1}:
${transcriptText(rows)}`;
  const output = await generator([
    { role: 'system', content: 'Bạn là chuyên viên kiểm kê sự kiện cuộc họp. Viết tiếng Việt, bám sát bằng chứng và tuyệt đối không bịa.' },
    { role: 'user', content: prompt },
  ], { max_new_tokens: 800, do_sample: false, repetition_penalty: 1.06 });
  return normalizeFactCard(extractJson(generatedContent(output)));
}

async function mergeCardBatch(cards, pass, batch, totalBatches) {
  const prompt = `Hợp nhất các thẻ sự kiện sau. Loại trùng lặp nhưng KHÔNG bỏ sót sự kiện khác nhau. Giữ nguyên evidence, owner, due và các thay đổi quyết định về sau. Không thêm dữ kiện mới.
Trả về duy nhất JSON cùng schema: overview, topics, decisions, actions, risks, questions; mỗi mục có text và evidence.

THẺ SỰ KIỆN:
${JSON.stringify(cards)}`;
  progress('llm-run', 74 + Math.min(14, pass * 4 + (batch + 1) / totalBatches * 4), `Đang hợp nhất bằng chứng — lượt ${pass}, nhóm ${batch + 1}/${totalBatches}…`);
  try {
    const output = await generator([
      { role: 'system', content: 'Bạn hợp nhất hồ sơ cuộc họp. Không lược bỏ dữ kiện có bằng chứng.' },
      { role: 'user', content: prompt },
    ], { max_new_tokens: 1000, do_sample: false, repetition_penalty: 1.06 });
    return normalizeFactCard(extractJson(generatedContent(output)));
  } catch (error) {
    console.warn('Fact-card merge fallback:', error);
    return combineCards(cards);
  }
}

async function hierarchicalMerge(cards) {
  let current = cards;
  let pass = 1;
  while (current.length > 4) {
    const groups = [];
    for (let index = 0; index < current.length; index += 4) groups.push(current.slice(index, index + 4));
    const next = [];
    for (let index = 0; index < groups.length; index += 1) next.push(await mergeCardBatch(groups[index], pass, index, groups.length));
    current = next;
    pass += 1;
  }
  return current;
}

function validEvidence(evidence, knownTimes) {
  return evidenceList(evidence).filter(time => knownTimes.has(time));
}

function validateNotes(notes, transcript, coverage) {
  const knownTimes = new Set(transcript.map(row => String(row.time || '')));
  const validate = item => {
    const evidence = validEvidence(item.evidence, knownTimes);
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
    percent: transcript.length && coverage.processedChunks === coverage.totalChunks ? 100 : Math.round(coverage.processedChunks / Math.max(1, coverage.totalChunks) * 100),
    lowConfidence,
    warnings: [...coverage.warnings, ...(lowConfidence ? [`${lowConfidence} kết luận chưa có mốc bằng chứng hợp lệ.`] : [])],
  };
  return validated;
}

function notesFromCards(cards, filename) {
  const combined = combineCards(cards);
  return normalizeNotes({
    title: filename.replace(/\.[^.]+$/, '') || 'Cuộc họp mới',
    summary: combined.overview || 'Chưa đủ nội dung để tóm tắt.',
    keyPoints: combined.topics,
    decisions: combined.decisions,
    actions: combined.actions,
    risks: combined.risks,
  }, filename);
}

async function summarize(message) {
  const chunks = chunkTranscript(message.transcript || []);
  const cards = [];
  const warnings = [];
  let fallback = false;
  try {
    await loadGenerator(message.webgpu);
    progress('llm-run', 4, `Đã chia transcript thành ${chunks.length} khối liên tiếp, không bỏ sót.`);
    for (let index = 0; index < chunks.length; index += 1) {
      progress('llm-run', 6 + (index / Math.max(1, chunks.length)) * 66, `Đang đọc toàn bộ khối ${index + 1}/${chunks.length}…`);
      try {
        cards.push(await analyzeChunk(chunks[index], message, index, chunks.length));
      } catch (error) {
        console.warn(`Chunk ${index + 1} fallback:`, error);
        cards.push(heuristicFactCard(chunks[index]));
        warnings.push(`Khối ${index + 1} dùng chế độ trích xuất nhẹ.`);
        fallback = true;
      }
    }
    const mergedCards = await hierarchicalMerge(cards);
    progress('llm-run', 91, 'Đang viết tóm tắt cuối từ hồ sơ đã kiểm kê…');
    const prompt = `Tạo biên bản cuối từ HỒ SƠ SỰ KIỆN đã được trích xuất từ toàn bộ transcript. Không bịa dữ kiện. ${templateInstructions[message.template] || templateInstructions.meeting}
Ghi chú định hướng: ${message.context || 'Không có'}
Từ vựng riêng cần giữ đúng chính tả: ${message.vocabulary || 'Không có'}
Tệp hình ảnh tham chiếu (chỉ dùng tên tệp làm ngữ cảnh, không suy đoán nội dung ảnh): ${(message.images || []).join(', ') || 'Không có'}
Trả về duy nhất JSON hợp lệ theo cấu trúc:
{"title":"tiêu đề ngắn","summary":"tóm tắt điều hành","keyPoints":[{"text":"điểm chính","evidence":["MM:SS"]}],"decisions":[{"text":"quyết định","context":"bối cảnh","evidence":["MM:SS"]}],"actions":[{"text":"việc cần làm","owner":"người phụ trách hoặc Chưa xác định","due":"thời hạn hoặc Chưa xác định","evidence":["MM:SS"]}],"risks":[{"text":"rủi ro","evidence":["MM:SS"]}]}

Tên file: ${message.filename}
HỒ SƠ SỰ KIỆN ĐÃ BAO PHỦ ${chunks.length}/${chunks.length} KHỐI:
${JSON.stringify(mergedCards)}`;
    const output = await generator([
      { role: 'system', content: 'Bạn là thư ký cuộc họp chuyên nghiệp. Viết tiếng Việt, chính xác, ngắn gọn và không suy diễn.' },
      { role: 'user', content: prompt },
    ], { max_new_tokens: 1100, do_sample: false, repetition_penalty: 1.06 });
    const notes = normalizeNotes(extractJson(generatedContent(output)), message.filename);
    const validated = validateNotes(notes, message.transcript, { totalChunks: chunks.length, processedChunks: cards.length, warnings });
    progress('llm-run', 100, `Đã phân tích ${cards.length}/${chunks.length} khối transcript.`);
    self.postMessage({ type: 'result', notes: validated, fallback });
  } catch (error) {
    console.warn('Local multi-pass summary fallback:', error);
    const notes = cards.length ? notesFromCards(cards, message.filename) : heuristicNotes(message.transcript, message.filename);
    const validated = validateNotes(notes, message.transcript, { totalChunks: chunks.length, processedChunks: cards.length || chunks.length, warnings: [...warnings, 'Bước tổng hợp cuối dùng chế độ nhẹ.'] });
    fallback = true;
    progress('llm-run', 100, `Đã phân tích ${validated.coverage.processedChunks}/${validated.coverage.totalChunks} khối transcript.`);
    self.postMessage({ type: 'result', notes: validated, fallback });
  }
}

function relevantSegments(transcript, question, limit = 6) {
  const words = question.toLocaleLowerCase('vi').split(/\s+/u).filter(word => word.length > 2);
  return transcript.map(row => ({ row, score: words.reduce((score, word) => score + (row.text.toLocaleLowerCase('vi').includes(word) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score).filter(item => item.score > 0).slice(0, limit).map(item => item.row);
}

async function ask(message) {
  const relevant = relevantSegments(message.transcript, message.question);
  try {
    await loadGenerator(message.webgpu);
    const evidence = relevant.length ? relevant : message.transcript.slice(0, 10);
    const prompt = `Chỉ trả lời dựa trên transcript được cung cấp. Nếu không đủ bằng chứng, nói rõ "Không tìm thấy trong bản ghi". Mỗi nhận định quan trọng phải kèm mốc thời gian dạng [MM:SS].

CÂU HỎI: ${message.question}

TRÍCH ĐOẠN LIÊN QUAN:
${evidence.map(row => `[${row.time}] ${row.speaker || 'Người nói'}: ${row.text}`).join('\n')}`;
    const output = await generator([
      { role: 'system', content: 'Bạn là trợ lý hỏi đáp cuộc họp. Trả lời ngắn gọn bằng tiếng Việt và luôn bám sát bằng chứng.' },
      { role: 'user', content: prompt },
    ], { max_new_tokens: 420, do_sample: false, repetition_penalty: 1.05 });
    const generated = output?.[0]?.generated_text;
    const answer = Array.isArray(generated) ? generated.at(-1)?.content : String(generated || '');
    const references = [...answer.matchAll(/\[(\d{1,2}):(\d{2})\]/g)].map(match => Number(match[1]) * 60 + Number(match[2]));
    self.postMessage({ type: 'answer', answer: answer || 'Không tìm thấy trong bản ghi.', references: [...new Set(references)] });
  } catch {
    const answer = relevant.length ? relevant.map(row => `[${row.time}] ${row.text}`).join('\n') : 'Không tìm thấy nội dung phù hợp trong bản ghi.';
    self.postMessage({ type: 'answer', answer, references: relevant.map(row => row.start || 0) });
  }
}

self.onmessage = async event => {
  try {
    if (event.data?.type === 'transcribe') await transcribe(event.data);
    if (event.data?.type === 'summarize') await summarize(event.data);
    if (event.data?.type === 'ask') await ask(event.data);
  } catch (error) {
    if (transcriber) await transcriber.dispose().catch(() => {});
    if (generator) await generator.dispose().catch(() => {});
    transcriber = null;
    generator = null;
    self.postMessage({ type: 'error', error: error.message || 'Không thể chạy AI trong trình duyệt.' });
  }
};
