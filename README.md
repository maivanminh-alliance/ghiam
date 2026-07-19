# MeetingMind Enterprise V9 — luồng backend công ty (schema 3.1)

## Bản sửa 9.1.0 — mind map cây SVG thuần + đồng bộ phiên bản

- Đồng bộ toàn bộ phiên bản 9.1.0 (index.html trước đó trỏ ?v=9.0.0 trong khi app.js/sw.js là 9.0.2 → service worker cache lệch file).
- Khôi phục khối "trạng thái xử lý thật" (đồng hồ chạy, chấm nhấp nháy, thời điểm tín hiệu gần nhất) bị thiếu trong index.html — trước đó app.js 9.0.2 ghi vào các phần tử không tồn tại.
- Mind map vẽ dạng CÂY bằng SVG thuần ngay trong app (root → nhánh màu → lá), không còn tải Mermaid từ CDN → hoạt động cả offline/PWA. Hỗ trợ 3 nguồn: mindMap object của backend, mã Mermaid `mindmap` (tự parse), fallback từ điểm chính/quyết định/đầu việc/rủi ro.
- Xuất SVG luôn hoạt động (không cần mở tab Mind map trước) và thêm xuất PNG (2x, nền sáng) để chèn vào Word/Zalo.
- Sửa lỗi tìm kiếm transcript khi từ khóa chứa ký tự & < > " '.
- Icon iPhone chuẩn (apple-touch-icon 180px, favicon SVG, icon 512 maskable) + manifest màu iOS.
- Service worker cache v17.

## Bản sửa 9.0.2 — hiển thị trạng thái xử lý thật

- Màn hình xử lý có đồng hồ chạy từng giây, chấm trạng thái nhấp nháy và thời điểm nhận tín hiệu gần nhất.
- Khi chờ OpenAI xử lý từng phần 10 phút, Worker gửi heartbeat 5 giây/lần để phân biệt đang chạy với treo.
- Từ 10 phút chưa có kết quả, trạng thái chuyển sang "đang chờ lâu hơn bình thường".
- Sau 20 phút không có phản hồi cho một phần, ứng dụng dừng và báo lỗi rõ; không tự gửi lại để tránh tính phí trùng.

## Bản sửa 9.0.1 — file M4A lớn

- Khắc phục lỗi `Audio file might be corrupted or unsupported` khi gửi file Voice Memos khoảng 60 MB.
- OpenAI Audio API giới hạn 25 MB mỗi file; ứng dụng không còn gửi nguyên file lớn.
- M4A lớn được giải mã cuốn chiếu thành WAV mono 16 kHz, mỗi phần 10 phút khoảng 19,2 MB, rồi gửi tuần tự tới backend.
- Không cắt byte thô của M4A nên mỗi phần vẫn là file âm thanh hợp lệ.
- Timestamp được cộng offset và ghép lại theo toàn bộ cuộc họp.
- Speaker của mỗi phần được tách phạm vi (`Phần 1 · ...`) vì nhãn diarization giữa các request không bảo đảm là cùng một người. Người dùng xác nhận tên trước khi phân tích.

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
Đưa toàn bộ file lên GitHub Pages; tải lại 2 lần sau cập nhật (service worker network-first, cache v16). Origin `https://maivanminh-alliance.github.io` đã được backend cho phép.
