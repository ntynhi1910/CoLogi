
"""Pure F1 supplier-capacity evaluation.

This module deliberately has no Django imports and performs no I/O.
Capacity is aggregated by Supplier + Item + Demand requested date.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Iterable


ZERO = Decimal("0")


class CapacityStatus(str, Enum):
    VERIFIED = "VERIFIED"
    UNVERIFIED = "UNVERIFIED"
    EXCEEDED = "EXCEEDED"
    INVALID_INPUT = "INVALID_INPUT"


@dataclass(frozen=True)
class PromiseCommitment:
    supplier_item_id: int
    item_id: int
    demand_item_id: int
    confirmed_weight_kg: Decimal
    line_status: str
    promised_weight_kg: Decimal
    links_valid: bool = True


@dataclass(frozen=True)
class SupplierRequestCommitment:
    """A single SupplierRequest attempt and its captured commitment lines."""

    request_id: int
    demand_id: int
    supplier_id: int
    attempt_no: int
    requested_date: date
    request_status: str
    confirmation_status: str
    commitment_released: bool
    promises: tuple[PromiseCommitment, ...]
    demand_status: str = "SUBMITTED"


@dataclass(frozen=True)
class SupplierItemCapacity:
    supplier_item_id: int
    supplier_id: int
    item_id: int
    max_daily_supply_kg: Decimal | None


@dataclass(frozen=True)
class CapacityResult:
    status: CapacityStatus
    supplier_id: int
    supplier_item_id: int
    item_id: int
    delivery_date: date
    committed_weight_kg: Decimal
    max_daily_supply_kg: Decimal | None
    contributing_demand_ids: tuple[int, ...]
    detail: str


def capacity_request_error(request: SupplierRequestCommitment) -> str | None:
    """Check the CP6 request and promise facts needed to trust capacity."""
    if request.request_status == "CANCELLED":
        valid_header = (request.confirmation_status in ("PENDING", "DECLINED")
                        or request.confirmation_status in ("CONFIRMED", "PARTIAL") and request.commitment_released)
    elif request.request_status in ("WAITING", "EXPIRED"):
        valid_header = request.confirmation_status == "PENDING"
    else:
        valid_header = (
            request.request_status == "RESPONDED"
            and request.confirmation_status in ("CONFIRMED", "PARTIAL", "DECLINED")
        )
    if not valid_header:
        return "SupplierRequest status and SupplierConfirmation status are inconsistent."
    if request.commitment_released and not (request.confirmation_status == "PARTIAL"
            or request.request_status == "CANCELLED" and request.confirmation_status == "CONFIRMED"):
        return "Only a PARTIAL confirmation can carry commitment release evidence."

    active_response = request.confirmation_status in ("CONFIRMED", "PARTIAL")
    if active_response and not request.promises:
        return "An active SupplierConfirmation has no Promise lines."

    seen_demand_items = set()
    for promise in request.promises:
        if not promise.links_valid:
            return "A commitment line has an invalid DemandItem, SupplierItem or Supplier relationship."
        if promise.demand_item_id in seen_demand_items:
            return "Duplicate promise for one DemandItem."
        seen_demand_items.add(promise.demand_item_id)

        confirmed = promise.confirmed_weight_kg
        promised = promise.promised_weight_kg
        if not confirmed.is_finite() or not promised.is_finite() or promised <= ZERO:
            return "Promise weights must be finite and promised weight must be positive."

        status = promise.line_status
        if status in ("PENDING", "DECLINED"):
            valid_quantity = confirmed == ZERO
        elif status == "CONFIRMED":
            valid_quantity = confirmed == promised
        else:
            valid_quantity = status == "PARTIAL" and ZERO < confirmed < promised
        if not valid_quantity:
            return "Confirmed quantity is inconsistent with the Promise line status."
        if confirmed > ZERO and not active_response:
            return "A positive Promise line is inconsistent with the confirmation status."
    return None


def evaluate_supplier_item_capacity(
    *,
    supplier_item: SupplierItemCapacity,
    delivery_date: date,
    requests: Iterable[SupplierRequestCommitment],
) -> CapacityResult:
    """Aggregate each unreleased commitment for a Supplier?Item?date bucket."""
    committed_total = ZERO
    contributing_demands: set[int] = set()
    maximum = supplier_item.max_daily_supply_kg

    def result(status, detail):
        return CapacityResult(
            status=status,
            supplier_id=supplier_item.supplier_id,
            supplier_item_id=supplier_item.supplier_item_id,
            item_id=supplier_item.item_id,
            delivery_date=delivery_date,
            committed_weight_kg=committed_total,
            max_daily_supply_kg=maximum,
            contributing_demand_ids=tuple(sorted(contributing_demands)),
            detail=detail,
        )

    if min(supplier_item.supplier_item_id, supplier_item.supplier_id, supplier_item.item_id) <= 0:
        return result(CapacityStatus.INVALID_INPUT, "SupplierItem identifiers must be positive.")
    if maximum is not None and (not maximum.is_finite() or maximum < ZERO):
        return result(CapacityStatus.INVALID_INPUT, "Maximum daily supply must be finite and non-negative.")

    seen_attempts = set()
    for request in requests:
        if request.supplier_id != supplier_item.supplier_id or request.requested_date != delivery_date:
            continue
        attempt = (request.demand_id, request.attempt_no)
        if attempt in seen_attempts:
            return result(CapacityStatus.INVALID_INPUT, "Duplicate SupplierRequest attempt.")
        seen_attempts.add(attempt)

        error = capacity_request_error(request)
        if error:
            return result(CapacityStatus.INVALID_INPUT, error)
        if request.commitment_released:
            continue

        for promise in request.promises:
            if promise.supplier_item_id != supplier_item.supplier_item_id:
                continue
            if promise.item_id != supplier_item.item_id:
                return result(CapacityStatus.INVALID_INPUT, "Promise Item does not match its SupplierItem Item.")
            if promise.confirmed_weight_kg > ZERO:
                committed_total += promise.confirmed_weight_kg
                contributing_demands.add(request.demand_id)

    if maximum is None:
        return result(CapacityStatus.UNVERIFIED, "SupplierItem.max_daily_supply_kg is NULL.")
    if committed_total > maximum:
        return result(CapacityStatus.EXCEEDED, "Effective commitments exceed SupplierItem daily capacity.")
    return result(CapacityStatus.VERIFIED, "Effective commitments are within SupplierItem daily capacity.")
