# MeetingMind Local — GitHub Pages

Website tĩnh dùng Transformers.js để chạy Whisper và Qwen ngay trong trình duyệt. Không cần máy chủ ứng dụng và không gọi API trả phí.

## Đưa lên GitHub Pages

1. Tạo repository GitHub mới.
2. Đưa toàn bộ file trong thư mục này vào thư mục gốc của repository.
3. Vào **Settings → Pages**.
4. Chọn **Deploy from a branch**, branch `main`, thư mục `/ (root)`.
5. Mở đường dẫn GitHub Pages được cấp.

Không mở `index.html` bằng `file://`, vì Web Worker và model AI cần website chạy qua HTTPS/localhost.

## Cách hoạt động

- Whisper ONNX tạo transcript tiếng Việt trong trình duyệt.
- Qwen2.5 0.5B Q4 đọc lần lượt 100% transcript theo nhiều khối, hợp nhất bằng chứng rồi tạo tóm tắt, quyết định và đầu việc.
- WebGPU được dùng khi trình duyệt hỗ trợ; WASM là chế độ dự phòng.
- Mô hình được tải từ Hugging Face ở lần dùng đầu và lưu trong bộ nhớ đệm của từng trình duyệt.
- File âm thanh không được tải lên máy chủ MeetingMind.

## Tính năng trợ lý ghi âm chuyên nghiệp

- Tải file hoặc ghi âm trực tiếp bằng micro.
- Auto generation và Custom generation theo ngôn ngữ, chất lượng, mẫu và từ vựng riêng.
- 8 mẫu biên bản: cuộc họp, điều hành, dự án, bán hàng, phỏng vấn, bài giảng, brainstorm và tùy chỉnh.
- Chỉnh nhãn người nói thủ công theo từng đoạn transcript.
- Tìm kiếm transcript và phát lại từ timestamp.
- Đánh dấu thời điểm quan trọng kèm ghi chú.
- Tóm tắt, quyết định, đầu việc và mind map.
- Hỏi AI dựa trên transcript, kèm mốc thời gian tham chiếu.
- Hiển thị độ bao phủ transcript, mốc bằng chứng và cảnh báo kết luận độ tin cậy thấp.
- Thư viện biên bản cục bộ trên từng trình duyệt.
- Xuất Markdown, TXT, SRT, Project JSON, PDF và Web Share.

## Giới hạn

- Lần đầu cần tải từ vài trăm MB đến hơn 1 GB tùy chế độ.
- Điện thoại cũ có thể chậm hoặc thiếu bộ nhớ; nên dùng chế độ **Nhanh**.
- Tách người nói chính xác chưa khả dụng trong bản chạy hoàn toàn trong trình duyệt.
