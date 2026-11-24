
"""Pure F1 Supplier Confirmation Gate.

No Django imports, database access, network access or mutations.
The caller supplies the latest SupplierRequest and its related records.
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from planning.f1.reasons import ordered_primary_reasons


ZERO = Decimal("0")


class ConfirmationGateStatus(str, Enum):
    ELIGIBLE = "ELIGIBLE"
    EXCLUDED = "EXCLUDED"
    INVALID_INPUT = "INVALID_INPUT"
    NOT_RESPONDED = "NOT_RESPONDED"


class ConfirmationFailure(str, Enum):
    PROMISE_MISSING = "PROMISE_MISSING"
    PROMISE_INSUFFICIENT = "PROMISE_INSUFFICIENT"
    INVALID_PROMISE_LINK = "INVALID_PROMISE_LINK"
    DUPLICATE_PROMISE = "DUPLICATE_PROMISE"
    UNEXPECTED_PROMISE = "UNEXPECTED_PROMISE"
    NO_DEMAND_ITEMS = "NO_DEMAND_ITEMS"


@dataclass(frozen=True)
class DemandItemRequirement:
    demand_item_id: int
    demand_id: int
    item_id: int
    required_weight_kg: Decimal


@dataclass(frozen=True)
class PromiseLine:
    promise_id: int
    supplier_request_id: int
    demand_id: int
    supplier_id: int
    demand_item_id: int
    item_id: int
    promised_weight_kg: Decimal
    confirmed_weight_kg: Decimal
    line_status: str
    links_valid: bool = True


@dataclass(frozen=True)
class SupplierResponseSnapshot:
    """The latest request attempt for one Demand.

    The adapter must select the latest request by (attempt_no, pk)
    before constructing this object. Historical attempts must not be merged.
    """

    supplier_request_id: int
    demand_id: int
    demand_supplier_id: int
    request_supplier_id: int
    request_status: str
    confirmation_status: str | None
    demand_items: tuple[DemandItemRequirement, ...]
    promises: tuple[PromiseLine, ...]


@dataclass(frozen=True)
class ConfirmationGateResult:
    status: ConfirmationGateStatus
    failure: ConfirmationFailure | None
    diagnostic_codes: tuple[str, ...]
    confirmed_weight_by_demand_item: tuple[tuple[int, Decimal], ...]
    detail: str
    reason_codes: tuple[str, ...] = ()


def _result(
    status: ConfirmationGateStatus,
    *,
    failure: ConfirmationFailure | None = None,
    diagnostics: tuple[str, ...] = (),
    confirmed: dict[int, Decimal] | None = None,
    detail: str,
    reasons: tuple[str, ...] = (),
) -> ConfirmationGateResult:
    confirmed = confirmed or {}
    return ConfirmationGateResult(
        status=status,
        failure=failure,
        diagnostic_codes=diagnostics,
        confirmed_weight_by_demand_item=tuple(sorted(confirmed.items())),
        detail=detail,
        reason_codes=reasons,
    )


def _valid_promise_quantity(promise):
    promised = promise.promised_weight_kg
    confirmed = promise.confirmed_weight_kg
    if not promised.is_finite() or not confirmed.is_finite() or promised <= ZERO:
        return False
    if promise.line_status in ("PENDING", "DECLINED"):
        return confirmed == ZERO
    if promise.line_status == "PARTIAL":
        return ZERO < confirmed < promised
    return promise.line_status == "CONFIRMED" and confirmed == promised


def evaluate_supplier_confirmation(response: SupplierResponseSnapshot) -> ConfirmationGateResult:
    """Evaluate all item failures from the latest attempt, in catalogue order."""
    if response.request_status != "RESPONDED":
        return _result(
            ConfirmationGateStatus.NOT_RESPONDED,
            detail="Only the latest RESPONDED SupplierRequest can be evaluated.",
            reasons=("LATEST_REQUEST_NOT_RESPONDED",),
        )

    if response.confirmation_status is None:
        return _result(
            ConfirmationGateStatus.INVALID_INPUT,
            detail="Latest SupplierRequest lacks a linked SupplierConfirmation.",
            reasons=("LATEST_CONFIRMATION_MISSING",),
        )

    if (
        min(response.supplier_request_id, response.demand_id, response.demand_supplier_id, response.request_supplier_id) <= 0
        or response.demand_supplier_id != response.request_supplier_id
    ):
        return _result(
            ConfirmationGateStatus.INVALID_INPUT,
            failure=ConfirmationFailure.INVALID_PROMISE_LINK,
            detail="Request, Demand and Supplier identities do not match.",
            reasons=("CONFIRMATION_LINK_MISMATCH",),
        )

    if response.confirmation_status not in ("CONFIRMED", "PARTIAL", "DECLINED"):
        return _result(
            ConfirmationGateStatus.INVALID_INPUT,
            detail="A responded request has an invalid confirmation status.",
        )

    requirements = {item.demand_item_id: item for item in response.demand_items}
    if not requirements or len(requirements) != len(response.demand_items) or any(
        item.demand_item_id <= 0 or item.demand_id != response.demand_id or item.item_id <= 0
        or not item.required_weight_kg.is_finite() or item.required_weight_kg <= ZERO
        for item in requirements.values()
    ):
        return _result(
            ConfirmationGateStatus.INVALID_INPUT,
            failure=ConfirmationFailure.NO_DEMAND_ITEMS,
            detail="DemandItem evidence is missing or invalid.",
            reasons=("DEMAND_VALIDATION_FAILED",),
        )

    reasons = set()
    diagnostics = set()
    counts = {item_id: 0 for item_id in requirements}
    valid_totals = {}
    valid_statuses = []
    has_unexpected_item = False
    has_invalid_quantity = False

    for promise in response.promises:
        requirement = requirements.get(promise.demand_item_id)
        if requirement is not None:
            counts[promise.demand_item_id] += 1
        else:
            has_unexpected_item = True
        if (
            requirement is None or promise.item_id != requirement.item_id
            or promise.supplier_request_id != response.supplier_request_id
            or promise.demand_id != response.demand_id
            or promise.supplier_id != response.request_supplier_id
            or not promise.links_valid
        ):
            reasons.add("PROMISE_LINK_MISMATCH")
            continue
        if not _valid_promise_quantity(promise):
            has_invalid_quantity = True
            continue

        valid_statuses.append(promise.line_status)
        total = valid_totals.get(promise.demand_item_id, ZERO)
        if promise.line_status == "CONFIRMED":
            total += promise.confirmed_weight_kg
        else:
            diagnostics.add("PROMISE_LINE_NOT_CONFIRMED")
        valid_totals[promise.demand_item_id] = total

    if any(count > 1 for count in counts.values()):
        reasons.add("PROMISE_DUPLICATE")
    if any(count == 0 for count in counts.values()):
        reasons.add("PROMISE_MISSING")
    if any(total < requirements[item_id].required_weight_kg for item_id, total in valid_totals.items()):
        reasons.add("PROMISE_INSUFFICIENT")

    if all(count == 1 for count in counts.values()) and len(valid_statuses) == len(requirements):
        statuses = set(valid_statuses)
        expected = (
            "CONFIRMED" if statuses == {"CONFIRMED"}
            else "DECLINED" if statuses == {"DECLINED"}
            else "PARTIAL"
        )
        if response.confirmation_status != expected or "PENDING" in statuses:
            diagnostics.add("CONFIRMATION_STATUS_INCONSISTENT")

    ordered = ordered_primary_reasons(reasons)
    failure_by_reason = {
        "PROMISE_DUPLICATE": ConfirmationFailure.DUPLICATE_PROMISE,
        "PROMISE_LINK_MISMATCH": (
            ConfirmationFailure.UNEXPECTED_PROMISE if has_unexpected_item else ConfirmationFailure.INVALID_PROMISE_LINK
        ),
        "PROMISE_MISSING": ConfirmationFailure.PROMISE_MISSING,
        "PROMISE_INSUFFICIENT": ConfirmationFailure.PROMISE_INSUFFICIENT,
    }
    if ordered or has_invalid_quantity:
        return _result(
            ConfirmationGateStatus.INVALID_INPUT if has_invalid_quantity or reasons.intersection(
                {"PROMISE_DUPLICATE", "PROMISE_LINK_MISMATCH"}
            ) else ConfirmationGateStatus.EXCLUDED,
            failure=failure_by_reason[ordered[0]] if ordered else None,
            diagnostics=tuple(sorted(diagnostics)),
            confirmed=valid_totals,
            detail="The latest Supplier response did not cover every DemandItem with a valid confirmed quantity.",
            reasons=ordered,
        )
    return _result(
        ConfirmationGateStatus.ELIGIBLE,
        diagnostics=tuple(sorted(diagnostics)),
        confirmed=valid_totals,
        detail="Every DemandItem is covered by a valid confirmed Promise.",
    )
