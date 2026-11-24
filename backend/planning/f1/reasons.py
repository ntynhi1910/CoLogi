"""Official F1 eligibility reason order from Acceptance Matrix v1.1.4."""

PRIMARY_REASON_PRECEDENCE = (
    "DEMAND_NOT_SUBMITTED",
    "DEMAND_VALIDATION_FAILED",
    "SUPPLIER_INACTIVE",
    "SUPPLIER_ITEM_INVALID",
    "INVALID_SOURCE_ITEM",
    "LATEST_REQUEST_MISSING",
    "LATEST_REQUEST_NOT_RESPONDED",
    "LATEST_CONFIRMATION_MISSING",
    "CONFIRMATION_LINK_MISMATCH",
    "PROMISE_DUPLICATE",
    "PROMISE_LINK_MISMATCH",
    "PROMISE_MISSING",
    "PROMISE_INSUFFICIENT",
)


def ordered_primary_reasons(reasons):
    found = set(reasons)
    return tuple(code for code in PRIMARY_REASON_PRECEDENCE if code in found)
