# Kiểm tra bản phát hành CoLogi v1.0.0

- PostgreSQL 17.12 trên database cô lập đã khôi phục được 67 bảng từ `database/cologi.dump`. Fingerprint từng bảng khớp manifest. Schema có 67 PK, 120 FK, 131 CHECK, 14 trigger nghiệp vụ và 61 sequence. Có 562 bút toán tồn đầu kỳ 15.000 kg trong các context đã lưu.
- 17/17 tài khoản demo đăng nhập được bằng mật khẩu tạo riêng cho bản cài. ID, vai trò, đơn vị và Outlet scope được bảo toàn. Chạy lại bootstrap không đặt lại mật khẩu. ACL runtime và giới hạn vai trò F1 đã được kiểm tra.
- Regression trên source phát hành đạt 197 tests và 26 subtests. Playwright headless đạt 8/8 ở 1440×1000 và 390×844. Frontend build với lockfile đạt. CP12 cung cấp bằng chứng kiểm thử Direct/Hub đã nghiệm thu, bao gồm đối soát và xử lý giao thiếu.
- Tạo bằng chứng cho ngày mẫu tương lai đã thử trên bản cài cô lập. Lần đầu ghi 523 revision `SYNTHETIC/CAPSTONE`, lần sau không ghi thêm. Dữ liệu kiểm thử này nằm ngoài dump phát hành.
- Docker build, restore trong container, tính bền vững qua restart container và GitHub Codespaces có trạng thái `NOT_VERIFIED`. Nghiệm thu nghiệp vụ thủ công cũng có trạng thái `NOT_VERIFIED`.
- Quá trình đóng gói dùng database nguồn chỉ đọc. Dump phát hành, workbook, ảnh và tài liệu được kiểm tra trước khi chuẩn bị commit cục bộ. Xem [phạm vi làm sạch và checksum](../../database/database_manifest.json), [quyền phát hành](../../docs/release-rights.md) và [hướng dẫn cài đặt](../../README.md).
