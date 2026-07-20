// MeetingMind V3 — xuất DOCX/PDF/CSV/SVG thật (09_PROFESSIONAL_PRODUCT_FEATURES)
// DOCX: bộ ghi ZIP store-only nội bộ → .docx OOXML hợp lệ, mở được trong Word/Google Docs, không cần CDN.

// ---------- ZIP store-only ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = []; const central = []; let offset = 0;
  const u16 = n => [n & 0xff, (n >> 8) & 0xff];
  const u32 = n => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nameBytes, data);
    const localLen = local.length + nameBytes.length + data.length;
    // Header + tên phải là MỘT cặp: bug cũ push thành 2 phần tử rời làm central directory toàn số 0 → Word/unzip báo file hỏng
    central.push([[...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)], nameBytes]);
    offset += localLen;
  }
  const centralStart = offset;
  let centralLen = 0;
  for (const [header, nameBytes] of central) { chunks.push(new Uint8Array(header), nameBytes); centralLen += header.length + nameBytes.length; }
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(centralLen), ...u32(centralStart), ...u16(0)];
  chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function xmlEscape(text) { return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }

// ---------- DOCX builder ----------
function para(text, { bold = false, size = 22, heading = 0, color = '' } = {}) {
  const runProps = `<w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/>${color ? `<w:color w:val="${color}"/>` : ''}</w:rPr>`;
  const pProps = heading ? `<w:pPr><w:pStyle w:val="Heading${heading}"/></w:pPr>` : '';
  const parts = String(text ?? '').split('\n');
  const runs = parts.map((line, i) => `<w:r>${runProps}${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`).join('');
  return `<w:p>${pProps}${runs}</w:p>`;
}
function bullet(text) { return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`; }

export function buildReportBlocks({ title, meta, notes, v3, transcript, metrics, gate, includeTranscript = true }) {
  const blocks = [];
  blocks.push({ type: 'h1', text: title });
  if (meta) blocks.push({ type: 'meta', text: meta });
  if (gate) blocks.push({ type: 'gate', releasable: gate.releasable, warnings: gate.warnings, metrics });
  blocks.push({ type: 'h2', text: 'Tóm tắt điều hành' });
  blocks.push({ type: 'p', text: notes.summary || v3?.executiveSummary || 'Chưa có tóm tắt.' });
  const list = (label, items, fmt) => { if (items?.length) { blocks.push({ type: 'h2', text: label }); items.forEach(item => blocks.push({ type: 'li', text: fmt(item) })); } };
  list('Điểm chính', notes.keyPoints, item => `${item.text || item}${refText(item)}`);
  list('Quyết định', notes.decisions, (item, i) => `${item.text}${item.context ? ' — ' + item.context : ''}${refText(item)}`);
  list('Việc cần làm', notes.actions, item => `${item.text} · ${item.owner || 'Chưa xác định'} · ${item.due || 'Chưa xác định'}${refText(item)}`);
  list('Rủi ro', notes.risks, item => `${item.text}${item.impact ? ' — ' + item.impact : ''}${refText(item)}`);
  if (v3) {
    list('Câu hỏi mở', v3.openQuestions, item => `${item.text}${refText(item)}`);
    list('Chờ phê duyệt', v3.pendingApprovals, item => `${item.text} — ${item.approver || ''}${refText(item)}`);
    if (v3.conflicts?.length) { blocks.push({ type: 'h2', text: 'Mâu thuẫn' }); v3.conflicts.forEach(c => blocks.push({ type: 'li', text: `${c.topic}: A) ${c.versionA?.text} [${(c.versionA?.evidence || []).join(', ')}] ↔ B) ${c.versionB?.text} [${(c.versionB?.evidence || []).join(', ')}]` })); }
    list('Số liệu thương mại/tài chính', v3.commercialFinancial, item => `${item.rawText}${item.verified ? ' ✓' : ' (chưa xác minh)'}${refText(item)}`);
  }
  if (metrics && transcript) {
    const queue = transcript.filter(row => row.status && row.status !== 'raw' && row.status !== 'verified');
    if (queue.length) { blocks.push({ type: 'h2', text: `Hàng chờ xác minh (${queue.length})` }); queue.forEach(row => blocks.push({ type: 'li', text: `[${row.time}] ${row.status}: ${row.text}` })); }
  }
  if (includeTranscript && transcript?.length) {
    blocks.push({ type: 'h2', text: 'Transcript' });
    transcript.forEach(row => blocks.push({ type: 'p', text: `[${row.time}] ${row.speaker || 'Người nói'}: ${row.text}` }));
  }
  return blocks;
}
function refText(item) { return item?.evidence?.length ? ` [${item.evidence.join(', ')}]` : ''; }

export function exportDocx(filename, blocks) {
  const body = blocks.map(block => {
    if (block.type === 'h1') return para(block.text, { bold: true, size: 40, heading: 1 });
    if (block.type === 'h2') return para(block.text, { bold: true, size: 28, heading: 2 });
    if (block.type === 'meta') return para(block.text, { size: 18, color: '888888' });
    if (block.type === 'gate') return para(`${block.releasable ? '✅ Đủ điều kiện phát hành' : '⛔ CHƯA đủ điều kiện phát hành'}${block.warnings?.length ? ' — ' + block.warnings.join('; ') : ''}`, { size: 20, color: block.releasable ? '2E7D32' : 'C62828' });
    if (block.type === 'li') return bullet(block.text);
    return para(block.text);
  }).join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  const blob = zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/numbering.xml', data: numbering },
    { name: 'word/document.xml', data: document },
  ]);
  triggerDownload(blob, `${filename}.docx`);
}

// ---------- PDF: in qua iframe ẩn → hộp thoại in / lưu PDF của trình duyệt ----------
// Dùng iframe thay window.open vì iOS ở chế độ PWA (Thêm vào MH chính) chặn cửa sổ mới.
export function exportPdf(filename, blocks) {
  const html = blocks.map(block => {
    if (block.type === 'h1') return `<h1>${xmlEscape(block.text)}</h1>`;
    if (block.type === 'h2') return `<h2>${xmlEscape(block.text)}</h2>`;
    if (block.type === 'meta') return `<p class="meta">${xmlEscape(block.text)}</p>`;
    if (block.type === 'gate') return `<p class="gate ${block.releasable ? 'ok' : 'block'}">${block.releasable ? '✅ Đủ điều kiện phát hành' : '⛔ CHƯA đủ điều kiện phát hành'}${block.warnings?.length ? ' — ' + xmlEscape(block.warnings.join('; ')) : ''}</p>`;
    if (block.type === 'li') return `<li>${xmlEscape(block.text)}</li>`;
    return `<p>${xmlEscape(block.text)}</p>`;
  }).join('').replace(/(<li>.*?<\/li>)(?!\s*<li>)/gs, '$1</ul>').replace(/(?<!<\/li>\s*)(<li>)/g, '<ul>$1');
  document.getElementById('printFrame')?.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'printFrame';
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${xmlEscape(filename)}</title><style>
    @page{size:A4;margin:18mm}
    body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;font-size:12pt;line-height:1.5}
    h1{font-size:22pt;margin:0 0 4pt} h2{font-size:14pt;margin:16pt 0 4pt;border-bottom:1px solid #ccc;padding-bottom:2pt}
    .meta{color:#888;font-size:9pt;margin:0 0 12pt} .gate{padding:6pt 10pt;border-radius:6pt;font-weight:600}
    .gate.ok{background:#e8f5e9;color:#2e7d32} .gate.block{background:#ffebee;color:#c62828}
    ul{margin:4pt 0 8pt;padding-left:18pt} li{margin:2pt 0} p{margin:4pt 0}
  </style></head><body>${html}</body></html>`);
  doc.close();
  setTimeout(() => {
    try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
    catch { iframe.remove(); alert('Không mở được hộp thoại in trên trình duyệt này.'); }
  }, 250);
}

// ---------- CSV (action/risk) ----------
export function exportCsv(filename, rows) {
  const escapeCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map(row => row.map(escapeCell).join(',')).join('\r\n');
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`);
}

// ---------- SVG (mind map) ----------
export function exportSvg(filename, svgElement) {
  if (!svgElement) return false;
  const source = new XMLSerializer().serializeToString(svgElement);
  triggerDownload(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }), `${filename}.svg`);
  return true;
}

function triggerDownload(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 800);
}
