# MeetingMind Enterprise V9 — luồng backend công ty (schema 3.1)

Website tĩnh (GitHub Pages). Ba bộ máy AI chọn trong tab Cài đặt:

- **Backend công ty (mặc định)**: không cần API key trong máy. Luồng 2 bước theo yêu cầu doanh nghiệp:
  `Audio → POST /transcribe (gpt-4o-transcribe-diarize) → người dùng sửa/xác nhận tên người nói → POST /analyze-transcript (gpt-5.6-sol) → BẢN NHÁP AI → 2 cổng duyệt → phê duyệt → xuất DOCX/PDF`.
  Chọn công ty **Alliance** (mặc định, dự án/công trường) hoặc **G.S Việt Nam** (nhân sự/chiến lược).
- **Gemini + Claude**: cần key Gemini + Claude, phiên âm 1 lần cả file.
- **OpenAI**: cần key OpenAI.

Backend production (không sửa, không đổi URL): `https://meetingmind-openai-backend.meetingmind-minh.workers.dev`

## Bảo mật
- KHÔNG có OpenAI key trong HTML/JS/localStorage — backend giữ key.
- Backend có domain allowlist: chỉ origin được cấu hình mới gọi được (localhost/origin lạ bị 403). Phải thêm origin GitHub Pages của bạn vào allowlist của Worker.
- Không lưu mẫu giọng, không tạo voiceprint.

## Quy trình kiểm duyệt (AI KHÔNG tự duyệt)
1. AI trả bản nháp `ai_draft`, `officialExportAllowed=false`.
2. Người dùng xử lý hàng chờ xác minh (tab Xác minh): nghe lại, cứu hộ (/rescue), xác nhận/từ chối.
3. Tick 2 cổng: (1) đã review anomaly/dữ kiện nhạy cảm, (2) đã review tổng thể; nhập người duyệt.
4. Đủ điều kiện → mở "Phê duyệt & xuất chính thức".
5. Sửa tên/nội dung hoặc đổi công ty sau duyệt → tự chuyển "Cần duyệt lại"/"Cần phân tích lại".

## Xuất file
- DOCX thật (.docx OOXML, bộ ghi ZIP nội bộ), PDF (in trình duyệt), CSV (action+risk), SVG (mind map), MD/TXT/SRT/JSON.
- Bản nháp có watermark "BẢN NHÁP AI — CHƯA PHÊ DUYỆT"; bản chính thức có người duyệt + thời điểm + phiên bản.

## Deploy
Đưa toàn bộ file lên GitHub Pages; tải lại 2 lần sau cập nhật (service worker network-first, cache v14). Thêm origin GitHub Pages vào allowlist backend.
