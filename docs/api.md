# API CoLogi

OpenAPI được Django tạo tại `/api/schema/`. Đăng nhập qua `POST /api/auth/login/` và dùng header `Authorization: Token …` trong phạm vi tài khoản.

| Nhóm | Đường dẫn |
|---|---|
| Sức khỏe dịch vụ | `/api/health/live/`, `/api/health/ready/` |
| Danh tính | `/api/auth/me/` |
| Demand | `/api/demands/` |
| F1 | `/api/planning/f1/selectable-demands/`, `/api/planning/f1/preview/`, `/api/planning/f1/runs/` |
| Tồn kho | `/api/planning/inventory/` |
| Kết quả F6 | `/api/planning/reconciliation/manager/` và các đường dẫn vai trò tương ứng |
| Hủy cam kết CP06 | `/api/planning/f1/demands/<id>/close-unplanned/` |

Phạm vi đọc/ghi phụ thuộc vai trò, đơn vị và context. Xem schema và API theo từng role đang chạy để lấy cấu trúc payload cụ thể.
