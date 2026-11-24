# Nghiệm thu CoLogi

1. **Purchasing Staff** tạo và gửi Demand ở Outlet được gán. Chọn ngày tương lai và cửa sổ giao còn hiệu lực.
2. **Supplier** trả lời yêu cầu theo từng SKU, cung cấp giờ sẵn sàng và kiểm tra tồn khả dụng. CP11 ghi nhận giữ chỗ khi cam kết.
3. **Manager** chạy DSS F1–F5, so sánh Direct/Hub, phê duyệt và bàn giao FinalPlan. Chỉ dùng luồng hủy cam kết CP06 sau khi đóng lần lập kế hoạch thất bại, không còn phương án khả thi và không còn FinalPlan hiệu lực.
4. **Transport Provider** xác nhận bàn giao, thực hiện chuyến và cập nhật mốc lấy/giao. **Purchasing** kiểm nhận thực tế. **Manager** đối soát giao nhận và chi phí, xử lý ngoại lệ và đóng FinalPlan.

## Ngày mô phỏng mới cho Capstone

Hãy chọn một ngày mẫu còn đủ bộ bằng chứng Capstone, ví dụ `2026-12-03`, và một ngày giao tương lai chưa được phủ bởi các bản ghi hiện có. Dùng môi trường cài đặt cục bộ. Chạy lần đầu để kiểm tra, sau đó thêm `--apply` khi đồng ý tạo bản ghi.

```sh
docker compose run --rm bootstrap python ../deploy/future_capstone.py \
  --template 2026-12-03 --date YYYY-MM-DD --manager-email admin@cologi.local
```

Script thêm phiên bản `SYNTHETIC/CAPSTONE` cho riêng ngày đó và liên kết từng bản ghi với ngày mẫu. Chọn tài khoản Capstone theo [DEMO_ACCOUNTS](../DEMO_ACCOUNTS.md) để tạo Demand, xác nhận và chạy DSS. Ngày mẫu là cấu hình mô phỏng, kể cả khi đã qua. Các mốc thực hiện theo workflow CP11 và ngày giờ của Demand mới.

## Nghiệm thu

Kiểm tra cả Direct và Hub, chứng từ mô phỏng, tải và giờ nhận, cập nhật tồn đúng một lần, đối soát và luồng `RELEASE` khi kết thúc lập kế hoạch thất bại. Kết quả nghiệp vụ cần người phụ trách xác nhận riêng.
