
"""Read immutable CP08 snapshots and adapt them to the pure F1 DTO."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from django.core.exceptions import ValidationError

from planning.json_validators import validate_demand_snapshot


@dataclass(frozen=True)
class SnapshotDemand:
    demand_id: int
    demand_code: str
    captured_at: str
    demand_values: Mapping
    related_records: Mapping


@dataclass(frozen=True)
class SnapshotRunData:
    demands: tuple
    capacity_requests: tuple


def _freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({
            key: _freeze(item)
            for key, item in value.items()
        })
    if isinstance(value, list):
        return tuple(_freeze(item) for item in value)
    return value


def _pk(value, context):
    if (
        not isinstance(value, str)
        or not value.isdigit()
        or value.startswith("0")
    ):
        raise ValidationError(f"{context} has an invalid canonical PK.")

    result = int(value)
    if result <= 0:
        raise ValidationError(f"{context} must be positive.")

    return result


def _int_value(value, context, *, nullable=False):
    if value is None and nullable:
        return None

    # JSON integer fields, e.g. ATTEMPT_NO.
    if isinstance(value, int) and not isinstance(value, bool):
        if value < 0:
            raise ValidationError(
                f"{context} must be a non-negative integer."
            )
        return value

    # Canonical string IDs/FKs, e.g. "201".
    return _pk(value, context)


def _snake_key(value):
    """Convert canonical UPPER_SNAKE_CASE to lower_snake_case."""
    return value.lower()


def _values(record, context):
    values = record.get("values")
    if not isinstance(values, Mapping):
        raise ValidationError(f"{context}.values must be an object.")

    return {
        _snake_key(key): value
        for key, value in values.items()
    }


def _record_index(records):
    """Index records by (source_kind, pk), rejecting conflicting copies."""
    result = {}

    for record in records:
        key = (record["source_kind"], record["pk"])
        previous = result.get(key)

        if previous is not None and dict(previous) != dict(record):
            raise ValidationError(
                f"Conflicting snapshot records: {key[0]}:{key[1]}"
            )

        result[key] = record

    return result


def _get_record(index, kinds, pk):
    if pk is None:
        return None

    for kind in kinds:
        record = index.get((kind, str(pk)))
        if record is not None:
            return record

    return None


def _required_record(index, kinds, pk, context):
    record = _get_record(index, kinds, pk)
    if record is None:
        raise ValidationError(
            f"Snapshot is missing required {context} record."
        )
    return record


def _adapt_demand_values(snapshot, index):
    raw = snapshot["demand_values"]
    values = {
        _snake_key(key): value
        for key, value in raw.items()
    }

    supplier = _required_record(
        index, ("SUPPLIER",), values["supplier_id"], "SUPPLIER"
    )
    category = _required_record(
        index,
        ("CARGO_CATEGORY",),
        values["cargo_category_id"],
        "CARGO_CATEGORY",
    )

    supplier_values = _values(supplier, "SUPPLIER")
    category_values = _values(category, "CARGO_CATEGORY")

    values["supplier_active"] = supplier_values["is_active"]
    values["cargo_category_active"] = category_values["is_active"]

    for key in ("supplier_id", "outlet_id", "cargo_category_id"):
        values[key] = _int_value(values[key], f"demand_values.{key}")

    return values


def _adapt_demand_items(index, demand_id):
    records = []

    for (kind, pk), record in index.items():
        if kind != "DEMAND_ITEM":
            continue

        values = _values(record, "DEMAND_ITEM")

        if _int_value(values["demand_id"], "DEMAND_ITEM.demand_id") != demand_id:
            continue

        item_id = _int_value(values["item_id"], "DEMAND_ITEM.item_id")
        item_record = _required_record(
            index, ("ITEM",), item_id, "ITEM"
        )
        item_values = _values(item_record, "ITEM")

        records.append({
            "id": _pk(pk, "DEMAND_ITEM.pk"),
            "item_id": item_id,
            "required_weight_kg": values["required_weight_kg"],
            "unit_of_measure": values["unit_of_measure"],
            "item": {
                "cargo_category_id": _int_value(
                    item_values["cargo_category_id"],
                    "ITEM.cargo_category_id",
                ),
                "weight_unit": item_values["weight_unit"],
                "is_active": item_values["is_active"],
            },
        })

    records.sort(key=lambda item: item["id"])
    return records


def _adapt_supplier_items(index, supplier_id, item_ids):
    records = []

    for (kind, pk), record in index.items():
        if kind != "SUPPLIER_ITEM":
            continue

        values = _values(record, "SUPPLIER_ITEM")
        record_supplier_id = _int_value(
            values["supplier_id"], "SUPPLIER_ITEM.supplier_id"
        )
        item_id = _int_value(
            values["item_id"], "SUPPLIER_ITEM.item_id"
        )

        if record_supplier_id != supplier_id or item_id not in item_ids:
            continue

        records.append({
            "id": _pk(pk, "SUPPLIER_ITEM.pk"),
            "supplier_id": record_supplier_id,
            "item_id": item_id,
            "offer_status": values["offer_status"],
            "unit_price_vnd_per_kg": values["unit_price_vnd_per_kg"],
            "max_daily_supply_kg": values["max_daily_supply_kg"],
            "minimum_order_kg": values["minimum_order_kg"],
            "lead_time_hours": values["lead_time_hours"],
        })

    records.sort(key=lambda item: (item["supplier_id"], item["item_id"], item["id"]))
    return records


def _adapt_capacity_requests(index):
    """Build request DTOs from the complete CAPACITY_* context."""
    demands = {}

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_DEMAND":
            continue

        values = _values(record, "CAPACITY_DEMAND")
        demands[_pk(pk, "CAPACITY_DEMAND.pk")] = values

    demand_items = {}
    item_ids_by_demand = {}

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_DEMAND_ITEM":
            continue

        values = _values(record, "CAPACITY_DEMAND_ITEM")
        demand_item_id = _pk(pk, "CAPACITY_DEMAND_ITEM.pk")
        demand_id = _int_value(values["demand_id"], "CAPACITY_DEMAND_ITEM.demand_id")
        demand_items[demand_item_id] = values
        item_ids_by_demand.setdefault(demand_id, []).append(demand_item_id)

    supplier_items = {}

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_SUPPLIER_ITEM":
            continue

        values = _values(record, "CAPACITY_SUPPLIER_ITEM")
        supplier_items[_pk(pk, "CAPACITY_SUPPLIER_ITEM.pk")] = values

    confirmations = {}

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_SUPPLIER_CONFIRMATION":
            continue

        confirmations[_pk(pk, "CAPACITY_SUPPLIER_CONFIRMATION.pk")] = (
            _values(record, "CAPACITY_SUPPLIER_CONFIRMATION")
        )

    promises_by_request = {}

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_SUPPLIER_ITEM_PROMISE":
            continue

        values = _values(record, "CAPACITY_SUPPLIER_ITEM_PROMISE")
        request_id = _int_value(
            values["supplier_request_id"],
            "CAPACITY_SUPPLIER_ITEM_PROMISE.supplier_request_id",
        )
        promises_by_request.setdefault(request_id, []).append(
            (_pk(pk, "CAPACITY_SUPPLIER_ITEM_PROMISE.pk"), values)
        )

    requests = []

    for (kind, pk), record in index.items():
        if kind != "CAPACITY_SUPPLIER_REQUEST":
            continue

        request_id = _pk(pk, "CAPACITY_SUPPLIER_REQUEST.pk")
        values = _values(record, "CAPACITY_SUPPLIER_REQUEST")

        demand_id = _int_value(
            values["demand_id"], "CAPACITY_SUPPLIER_REQUEST.demand_id"
        )
        supplier_id = _int_value(
            values["supplier_id"], "CAPACITY_SUPPLIER_REQUEST.supplier_id"
        )
        confirmation_id = _int_value(
            values["supplier_confirmation_id"],
            "CAPACITY_SUPPLIER_REQUEST.supplier_confirmation_id",
            nullable=True,
        )

        demand = demands.get(demand_id)
        if demand is None:
            raise ValidationError(
                "Capacity request references a missing CAPACITY_DEMAND."
            )

        confirmation = None
        confirmation_demand_id = None
        confirmation_supplier_id = None

        if confirmation_id is not None:
            confirmation = confirmations.get(confirmation_id)

            if confirmation is None:
                raise ValidationError(
                    "Capacity request references a missing confirmation."
                )

            confirmation_demand_id = _int_value(
                confirmation["demand_id"],
                "CAPACITY_SUPPLIER_CONFIRMATION.demand_id",
            )
            confirmation_supplier_id = _int_value(
                confirmation["supplier_id"],
                "CAPACITY_SUPPLIER_CONFIRMATION.supplier_id",
            )


        if confirmation_id is not None and (
            confirmation_demand_id != demand_id
            or confirmation_supplier_id != supplier_id
        ):
            raise ValidationError(
                "SupplierConfirmation link does not match its Request."
            )

        promises = []

        for promise_id, promise_values in promises_by_request.pop(
            request_id, ()
        ):
            demand_item_id = _int_value(
                promise_values["demand_item_id"],
                "CAPACITY_PROMISE.demand_item_id",
            )
            supplier_item_id = _int_value(
                promise_values["supplier_item_id"],
                "CAPACITY_PROMISE.supplier_item_id",
            )

            demand_item = demand_items.get(demand_item_id)
            supplier_item = supplier_items.get(supplier_item_id)

            if demand_item is None or supplier_item is None:
                raise ValidationError(
                    "Capacity Promise references a missing item record."
                )

            promise_demand_id = _int_value(
                demand_item["demand_id"],
                "CAPACITY_DEMAND_ITEM.demand_id",
            )
            promise_item_id = _int_value(
                demand_item["item_id"],
                "CAPACITY_DEMAND_ITEM.item_id",
            )
            supplier_item_supplier_id = _int_value(
                supplier_item["supplier_id"],
                "CAPACITY_SUPPLIER_ITEM.supplier_id",
            )
            supplier_item_item_id = _int_value(
                supplier_item["item_id"],
                "CAPACITY_SUPPLIER_ITEM.item_id",
            )

            promises.append({
                "id": promise_id,
                "supplier_request_id": request_id,
                "demand_item_id": demand_item_id,
                "demand_item_demand_id": promise_demand_id,
                "supplier_item_id": supplier_item_id,
                "item_id": promise_item_id,
                "promised_weight_kg": promise_values["promised_weight_kg"],
                "confirmed_weight_kg": promise_values["confirmed_weight_kg"],
                "line_status": promise_values["line_status"],
                "supplier_item_supplier_id": supplier_item_supplier_id,
                "supplier_item_item_id": supplier_item_item_id,
            })

        promises.sort(key=lambda item: item["id"])

        requests.append({
            "id": request_id,
            "demand_id": demand_id,
            "requested_date": demand["requested_date"],
            "demand_status": demand["status"],
            "supplier_id": supplier_id,
            "attempt_no": _int_value(
                values["attempt_no"],
                "CAPACITY_SUPPLIER_REQUEST.attempt_no",
            ),
            "request_status": values["request_status"],
            "demand_item_ids": sorted(item_ids_by_demand.get(demand_id, ())),
            "confirmation": (
                None
                if confirmation is None
                else {
                    "id": confirmation_id,
                    "demand_id": confirmation_demand_id,
                    "supplier_id": confirmation_supplier_id,
                    "confirmation_status": confirmation["confirmation_status"],
                    "commitment_released": (
                        confirmation["commitment_released_at"] is not None
                    ),
                }
            ),
            "promises": promises,
        })

    if promises_by_request:
        raise ValidationError("Capacity Promise references a missing SupplierRequest.")

    requests.sort(
        key=lambda item: (
            item["demand_id"],
            item["attempt_no"],
            item["id"],
        )
    )
    return requests


def _adapt_flat_snapshot(snapshot):
    records = snapshot["related_records"]
    index = _record_index(records)

    demand_id = _pk(snapshot["demand_ref"]["pk"], "demand_ref.pk")
    demand_values = _adapt_demand_values(snapshot, index)

    demand_record = _required_record(
        index, ("DEMAND",), str(demand_id), "DEMAND"
    )
    demand_record_values = _values(demand_record, "DEMAND")

    if demand_record_values["demand_code"] != demand_values["demand_code"]:
        raise ValidationError("Demand code does not match demand_ref.")

    demand_items = _adapt_demand_items(index, demand_id)
    item_ids = {item["item_id"] for item in demand_items}

    supplier_items = _adapt_supplier_items(
        index,
        demand_values["supplier_id"],
        item_ids,
    )
    sourcing_options = [
        _values(record, kind) for (kind, _), record in index.items()
        if kind == "DEMAND_SOURCING_OPTION"
    ]

    capacity_requests = _adapt_capacity_requests(index)

    # All capacity history is captured for the selected date bucket.
    # The same immutable context is intentionally repeated per Demand.
    related = {
        "demand_items": demand_items,
        "supplier_items": supplier_items,
        "sourcing_options": sourcing_options,
        "capacity_requests": capacity_requests,
        "supplier_confirmations": [],
    }

    return SnapshotDemand(
        demand_id=demand_id,
        demand_code=demand_values["demand_code"],
        captured_at=snapshot["captured_at"],
        demand_values=_freeze(demand_values),
        related_records=_freeze(related),
    )


def _adapt_v1(snapshot):
    """
    Schema 1.0 uses the same flat related_records envelope.
    It differs from 1.1 by having no gate_evidence.
    """
    if "gate_evidence" in snapshot:
        raise ValidationError(
            "Schema 1.0 must not contain gate_evidence."
        )

    return _adapt_flat_snapshot(snapshot)


def read_demand_snapshot(snapshot):
    if not isinstance(snapshot, dict):
        raise ValidationError("Snapshot must be a JSON object.")

    validate_demand_snapshot(snapshot)

    version = snapshot["schema_version"]

    if version == "1.0":
        return _adapt_v1(snapshot)

    if version == "1.1":
        return _adapt_flat_snapshot(snapshot)

    raise ValidationError("Unsupported snapshot schema version.")


def read_run_snapshots(snapshots):
    demands_list = []
    all_records = []

    # Đọc và xác thực từng snapshot trước khi tổng hợp dữ liệu.
    for snapshot in snapshots:
        demand = read_demand_snapshot(snapshot)
        demands_list.append(demand)
        all_records.extend(snapshot["related_records"])

    # Phát hiện bản ghi cùng source_kind + PK nhưng khác nội dung
    # giữa các Demand Snapshot.
    _record_index(all_records)

    demands = tuple(demands_list)
    demand_ids = [demand.demand_id for demand in demands]

    if len(demand_ids) != len(set(demand_ids)):
        raise ValidationError(
            "PlanningRun contains duplicate Demand snapshots."
        )

    requests_by_id = {}

    for demand in demands:
        for request in demand.related_records["capacity_requests"]:
            request_id = request["id"]
            existing = requests_by_id.get(request_id)

            if existing is not None and dict(existing) != dict(request):
                raise ValidationError(
                    "Conflicting copies of a capacity request were found."
                )

            requests_by_id[request_id] = request

    return SnapshotRunData(
        demands=demands,
        capacity_requests=tuple(
            _freeze(requests_by_id[key])
            for key in sorted(requests_by_id)
        ),
    ) 

