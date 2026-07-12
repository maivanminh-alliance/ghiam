// MeetingMind Enterprise V3 — cấu hình phân tích (01_MASTER_SYSTEM_PROMPT + 02 + 03 + 08)
export const BACKEND_URL = 'https://meetingmind-openai-backend.meetingmind-minh.workers.dev/analyze';

export const TEMPLATE_IDS = ['executive_strategy', 'investor_steering', 'project_progress', 'design_coordination', 'site_coordination', 'procurement_material', 'commercial_contract', 'finance_budget', 'qa_qc_acceptance', 'hse_safety', 'hr_organization', 'sales_business', 'legal_governance', 'handover_operation', 'cross_functional'];

export const GLOSSARY = {
  stakeholders: { CDT: ['Chủ đầu tư', 'Owner', 'Developer'], BQLDA: ['Ban quản lý dự án', 'PMU'], PMC: ['Tư vấn quản lý dự án'], TVGS: ['Tư vấn giám sát'], TVTK: ['Tư vấn thiết kế'], TongThau: ['Tổng thầu', 'Main Contractor'], NhaThauPhu: ['Nhà thầu phụ'], NCC: ['Nhà cung cấp', 'Vendor'] },
  documents: { RFI: 'yêu cầu làm rõ thông tin', submittal: 'hồ sơ trình duyệt', 'shop drawing': 'bản vẽ triển khai', NCR: 'báo cáo không phù hợp', ITP: 'kế hoạch kiểm tra thử nghiệm', MIR: 'yêu cầu kiểm tra vật liệu', WIR: 'yêu cầu kiểm tra công việc' },
  commercial: { BOQ: 'bảng khối lượng', variation: 'phát sinh', VO: 'variation order', EOT: 'gia hạn', retention: 'tiền giữ lại', 'advance payment': 'tạm ứng', IPC: 'chứng nhận thanh toán tạm' },
  construction: { MEP: 'cơ điện nước', HVAC: 'điều hòa thông gió', ELV: 'điện nhẹ', PCCC: 'phòng cháy chữa cháy', 'FF&E': 'nội thất thiết bị phụ kiện', joinery: 'đồ gỗ', 'mock-up': 'mẫu thử thực tế', 'punch list': 'danh sách lỗi hoàn thiện' },
};

// Master system prompt (rút gọn có kiểm soát từ 01 + quy tắc suy luận 08). Model trả JSON theo 04_OUTPUT_SCHEMA.
export const MASTER_SYSTEM_PROMPT = `Bạn là MeetingMind Enterprise Intelligence, thư ký điều hành cấp cao cho doanh nghiệp xây dựng và nội thất (Chủ đầu tư, BQLDA, PMC, TVGS, TVTK, Tổng thầu, Nhà thầu phụ, NCC, các phòng HR/Tài chính/Mua sắm/QAQC/HSE...).
MỤC TIÊU: đọc TOÀN BỘ transcript theo thời gian; bảo toàn con số, đơn vị, ngày, mã hồ sơ, trách nhiệm; tự phân loại cuộc họp và chọn mẫu báo cáo; tách dữ kiện/ý kiến/đề xuất/quyết định/hành động/rủi ro/mâu thuẫn/câu hỏi mở; mọi kết luận truy nguyên được tới timestamp.
QUY TẮC KHÔNG BỊA (bắt buộc):
- Chỉ ghi là quyết định khi có bằng chứng chốt/thống nhất/phê duyệt/đồng ý rõ ràng. "Đề nghị", "có thể", "phương án" KHÔNG phải quyết định. "Sẽ làm" không tự động có deadline. Chi phí dự kiến không phải chi phí được duyệt.
- Không tự gán owner, deadline, chi phí, khối lượng, trạng thái. Action thiếu owner/deadline ghi "Chưa xác định".
- Không tự sửa con số; hai con số mâu thuẫn thì ghi cả hai vào conflicts kèm 2 timestamp.
- Speaker chỉ là nhãn (Người nói A/B...); không đoán tên thật.
- Nghe không rõ ghi [CẦN XÁC MINH]. Không dùng kiến thức ngoài transcript.
- Không trộn lẫn Chủ đầu tư / Tư vấn / Tổng thầu / Nhà thầu phụ / Nhà cung cấp. MEP, MVP, MPP không tự coi là một.
PHÂN TẦNG BẰNG CHỨNG: mỗi decision/action/risk/số liệu có evidence (mốc thời gian sao chép NGUYÊN VĂN từ đầu dòng transcript), sourceSpeaker, confidence (high/medium/low), evidenceStatus (verified/supported/uncertain/conflicting).
PHÂN LOẠI: chọn selectedTemplate trong: ${TEMPLATE_IDS.join(', ')}; kèm confidence và reason.
Trả về DUY NHẤT JSON hợp lệ, không markdown.`;

// Schema JSON V3 mô tả trong prompt (04_OUTPUT_SCHEMA.json)
export const V3_SCHEMA_PROMPT = `{"schemaVersion":"3.0","selectedTemplate":{"id":"","confidence":0,"reason":""},"meeting":{"title":"","type":[],"organizations":[],"projects":[],"participants":[]},"executiveSummary":"5-10 câu cho lãnh đạo","context":"bối cảnh ngắn","topicTimeline":[{"topic":"","startTime":"MM:SS","endTime":"MM:SS","summary":""}],"facts":[{"text":"","evidence":["MM:SS"],"sourceSpeaker":"","confidence":"high","evidenceStatus":"verified"}],"optionsDiscussed":[{"text":"","evidence":["MM:SS"]}],"decisions":[{"text":"","context":"","evidence":["MM:SS"],"sourceSpeaker":"","confidence":"high","evidenceStatus":"verified"}],"actions":[{"text":"","owner":"Chưa xác định","collaborators":[],"due":"Chưa xác định","priority":"","evidence":["MM:SS"],"sourceSpeaker":"","confidence":"high","evidenceStatus":"supported"}],"risks":[{"text":"","impact":"","mitigation":"","owner":"Chưa xác định","evidence":["MM:SS"],"confidence":"medium","evidenceStatus":"supported"}],"openQuestions":[{"text":"","evidence":["MM:SS"]}],"conflicts":[{"topic":"","versionA":{"text":"","evidence":["MM:SS"]},"versionB":{"text":"","evidence":["MM:SS"]}}],"pendingApprovals":[{"text":"","approver":"","evidence":["MM:SS"]}],"projectStatus":[{"area":"","status":"","evidence":["MM:SS"]}],"commercialFinancial":[{"rawText":"","normalizedValue":"","unit":"","evidence":["MM:SS"],"sourceSpeaker":"","confidence":"medium","verified":false}],"peopleOrganization":[{"text":"","evidence":["MM:SS"]}],"confidentialNotes":[{"text":"","evidence":["MM:SS"]}],"keyPoints":[{"text":"","evidence":["MM:SS"]}],"mindmap":"mã Mermaid mindmap tiếng Việt, dòng đầu là mindmap, node gốc root((tiêu đề)), tối đa 3 cấp ~25 node, không dùng ()[]{} trong tên node"}`;

export const ASK_SYSTEM_PROMPT = 'Chỉ trả lời dựa trên transcript của cuộc họp hiện tại. Mỗi kết luận phải dẫn timestamp dạng [MM:SS] hoặc [HH:MM:SS] sao chép từ transcript. Nếu không tìm thấy, nói rõ "Không tìm thấy trong cuộc họp". Không suy đoán trách nhiệm, deadline, giá trị hợp đồng, khối lượng hoặc quyết định. Trả lời tiếng Việt ngắn gọn.';

export function buildAnalysisPrompt({ template, context, vocabulary, filename, transcriptText, quarantineNote }) {
  return `Phân tích transcript cuộc họp bên dưới và tạo biên bản cấp doanh nghiệp.
Mẫu người dùng gợi ý: ${template || 'tự chọn'}. Ghi chú định hướng: ${context || 'Không có'}.
Từ điển tổ chức (chỉ dùng để hiểu thuật ngữ, KHÔNG ép sửa transcript): ${JSON.stringify(GLOSSARY)}
Từ vựng riêng của người dùng: ${vocabulary || 'Không có'}.
${quarantineNote ? `LƯU Ý CHẤT LƯỢNG: ${quarantineNote} Các đoạn đó KHÔNG có trong transcript dưới đây và tuyệt đối không được suy đoán nội dung của chúng.` : ''}
Tên file: ${filename}
Trả về DUY NHẤT JSON hợp lệ theo cấu trúc sau (giữ nguyên tên trường, điền mảng rỗng nếu không có dữ liệu):
${V3_SCHEMA_PROMPT}

TRANSCRIPT:
${transcriptText}`;
}
