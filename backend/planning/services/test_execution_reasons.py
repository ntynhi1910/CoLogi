import pytest

from planning.services.execution_reasons import resolve_reason
from planning.services.inventory import ExecutionBlocked


def resolve(action, **values):
    return resolve_reason(action, **{"short": False, "legacy": "", "code": "", "other": "", "note": "",
                                    "incident": "", **values})


@pytest.mark.parametrize(("action", "values", "expected"), [
    ("READY", {}, ""),
    ("SUPPLIER_HANDOVER", {"code": "PARTIAL", "short": True, "note": "Đã kiểm đếm"}, "Bàn giao một phần · Đã kiểm đếm"),
    ("RECEIVE", {"code": "OTHER", "short": True, "other": "Thiếu một kiện"}, "Thiếu một kiện"),
    ("INCIDENT", {"code": "DAMAGED"}, "DAMAGED: Hàng hư hỏng"),
    ("INCIDENT", {"code": "OTHER", "other": "Hỏng thùng", "incident": "DAMAGED"}, "DAMAGED: Hỏng thùng"),
    ("CARRIER_PICKUP", {"legacy": "Lý do đã lưu trước đây", "short": True}, "Lý do đã lưu trước đây"),
])
def test_audit_text(action, values, expected):
    assert resolve(action, **values) == expected


@pytest.mark.parametrize(("action", "values", "expected"), [
    ("READY", {"code": "FULL"}, "REASON_ACTION_INVALID"),
    ("RECEIVE", {"code": "FULL", "short": True}, "REASON_QUANTITY_MISMATCH"),
    ("DELIVER", {"code": "PARTIAL"}, "REASON_QUANTITY_MISMATCH"),
    ("CARRIER_PICKUP", {"short": True, "note": "Ghi chú"}, "DISCREPANCY_REASON_REQUIRED"),
    ("INCIDENT", {"code": "OTHER"}, "REASON_OTHER_REQUIRED"),
    ("INCIDENT", {"code": "OTHER", "other": "Xe hỏng"}, "INCIDENT_CODE_REQUIRED"),
])
def test_reject_invalid_reason(action, values, expected):
    with pytest.raises(ExecutionBlocked) as blocked:
        resolve(action, **values)
    assert str(blocked.value.detail["code"]) == expected
