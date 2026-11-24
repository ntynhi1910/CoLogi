"""Execution reason presets and the existing, immutable audit text contract."""

from planning.services.inventory import ExecutionBlocked

INCIDENTS = {
    "SHORTAGE": "Thiếu hàng", "DAMAGED": "Hàng hư hỏng", "PICKUP_LATE": "Lấy hàng trễ",
    "DELIVERY_LATE": "Giao hàng trễ", "QUANTITY_MISMATCH": "Số lượng không khớp",
    "DELIVERY_IMPOSSIBLE": "Không thể giao hàng", "VEHICLE_UNAVAILABLE": "Phương tiện không khả dụng",
}
PRESETS = {
    "READY": {"PREPARED": "Đã chuẩn bị đủ hàng", "QUALITY_CHECKED": "Đã kiểm tra chất lượng",
              "PACKED": "Hàng đã đóng gói"},
    "ARRIVE": {"ARRIVED": "Đã đến điểm dừng"},
    "SUPPLIER_HANDOVER": {"FULL": "Bàn giao đủ theo kế hoạch", "PARTIAL": "Bàn giao một phần",
                          "ADJUST_QUANTITY": "Điều chỉnh số lượng"},
    "CARRIER_PICKUP": {"FULL": "Đã nhận đủ hàng", "PARTIAL": "Thiếu hàng", "QUALITY": "Hàng không đạt yêu cầu"},
    "HUB_RECEIVE": {"TRANSFER": "Đã kiểm đếm tại Hub"},
    "HUB_DISPATCH": {"TRANSFER": "Đã bàn giao cho chuyến ra Hub"},
    "DELIVER": {"FULL": "Giao đủ hàng", "PARTIAL": "Giao một phần", "REFUSED": "Người nhận từ chối một phần"},
    "RECEIVE": {"FULL": "Kiểm nhận đủ", "PARTIAL": "Thực nhận thiếu", "QUALITY": "Hàng hư hỏng hoặc không đạt"},
    "INCIDENT": INCIDENTS,
}
DISCREPANCY_ACTIONS = ("SUPPLIER_HANDOVER", "CARRIER_PICKUP", "RECEIVE")
SHORT_ONLY = {"PARTIAL", "ADJUST_QUANTITY", "REFUSED"}


def resolve_reason(action, *, short, legacy, code, other, note, incident):
    if legacy and (code or other or note or incident):
        raise ExecutionBlocked("REASON_FORMAT_INVALID")
    if legacy:
        # Old callers sent free text, which remains equivalent to a custom reason.
        if action == "INCIDENT":
            kind, _, detail = legacy.partition(":")
            if kind not in INCIDENTS or not detail.strip():
                raise ExecutionBlocked("INCIDENT_CODE_REQUIRED")
        return legacy
    if (code == "OTHER") != bool(other):
        raise ExecutionBlocked("REASON_OTHER_REQUIRED" if code == "OTHER" else "REASON_FORMAT_INVALID")
    if not code and (action == "INCIDENT" or short and action in DISCREPANCY_ACTIONS):
        raise ExecutionBlocked("INCIDENT_CODE_REQUIRED" if action == "INCIDENT" else "DISCREPANCY_REASON_REQUIRED")
    if code and code != "OTHER" and code not in PRESETS.get(action, {}):
        raise ExecutionBlocked("REASON_ACTION_INVALID")
    if (code == "FULL" and short) or (code in SHORT_ONLY and not short):
        raise ExecutionBlocked("REASON_QUANTITY_MISMATCH")
    reason = other or PRESETS.get(action, {}).get(code, "")
    if action == "INCIDENT":
        kind = incident if code == "OTHER" else code
        if kind not in INCIDENTS or incident and code != "OTHER":
            raise ExecutionBlocked("INCIDENT_CODE_REQUIRED")
        reason = f"{kind}: {reason}"
    elif incident:
        raise ExecutionBlocked("REASON_ACTION_INVALID")
    result = " · ".join(filter(None, (reason, note)))
    if len(result) > 500:
        raise ExecutionBlocked("REASON_TOO_LONG")
    return result
