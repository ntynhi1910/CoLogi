"""Project display evidence from F1 snapshots without updating persisted results."""

from collections.abc import Mapping
from decimal import Decimal

from django.core.exceptions import ValidationError

from masterdata.models import Item, Outlet, Supplier
from planning.services.snapshot_evaluator import _build_confirmation_result, _latest_request_by_demand
from planning.services.snapshot_reader import read_demand_snapshot


def _mapping(value):
    return value if isinstance(value, Mapping) else {}


def _text(value):
    return value if isinstance(value, str) and value else None


def _display_pk(value):
    if type(value) is not int and not (
        isinstance(value, str) and len(value) <= 19 and value.isascii() and value.isdecimal()
    ):
        return None
    pk = int(value)
    return pk if 0 < pk <= 9223372036854775807 else None


def _master_labels(model, ids, code_field, name_field):
    return {
        pk: {"code": code, "name": name}
        for pk, code, name in model.objects.filter(pk__in=ids).values_list("pk", code_field, name_field)
    }


def resolve_demand_display_labels(snapshots_by_id, outlet_ids):
    """Read current labels for authorized snapshot references only."""
    outlets_in_scope = set(outlet_ids)
    refs = {}
    for demand_id, raw in snapshots_by_id.items():
        snapshot = _mapping(raw)
        evidence = describe_demand_snapshot(snapshot, demand_id)
        if evidence is None:
            continue
        demand = _mapping(snapshot.get("demand_values"))
        outlet_id = _display_pk(demand.get("OUTLET_ID"))
        if outlet_id not in outlets_in_scope:
            continue
        supplier_id = _display_pk(demand.get("SUPPLIER_ID"))
        items = {_display_pk(row["item_id"]) for row in evidence["items"] or ()} - {None}
        refs[demand_id] = (supplier_id, outlet_id, items)

    suppliers = _master_labels(Supplier, {ref[0] for ref in refs.values()} - {None}, "supplier_code", "supplier_name")
    outlets = _master_labels(Outlet, {ref[1] for ref in refs.values()}, "outlet_code", "outlet_name")
    items = _master_labels(Item, {pk for ref in refs.values() for pk in ref[2]}, "item_code", "item_name")
    return {
        demand_id: {
            "source": "CURRENT_MASTERDATA",
            "supplier": suppliers.get(supplier_id),
            "outlet": outlets.get(outlet_id),
            "items": {pk: items[pk] for pk in sorted(item_ids) if pk in items},
        }
        for demand_id, (supplier_id, outlet_id, item_ids) in refs.items()
    }


def _shortfalls(snapshot):
    try:
        demand = read_demand_snapshot(snapshot)
        latest = _latest_request_by_demand(demand.related_records["capacity_requests"])
        confirmation = _build_confirmation_result(demand, latest.get(demand.demand_id))
    except ValidationError:
        return None

    if "PROMISE_INSUFFICIENT" not in confirmation.reason_codes:
        return None

    confirmed = dict(confirmation.confirmed_weight_by_demand_item)
    shortfalls = []
    for item in demand.related_records["demand_items"]:
        required = Decimal(item["required_weight_kg"])
        fulfilled = confirmed.get(int(item["id"]))
        if fulfilled is not None and fulfilled < required:
            shortfalls.append({
                "demand_item_id": str(item["id"]),
                "required_weight_kg": format(required, "f"),
                "confirmed_weight_kg": format(fulfilled, "f"),
                "shortfall_weight_kg": format(required - fulfilled, "f"),
            })
    return shortfalls or None


def describe_demand_snapshot(snapshot, demand_id, *, show_shortfall=False):
    snapshot = _mapping(snapshot)
    if str(_mapping(snapshot.get("demand_ref")).get("pk")) != str(demand_id):
        return None

    demand = _mapping(snapshot.get("demand_values"))
    records = snapshot.get("related_records")
    records = [row for row in records if isinstance(row, Mapping)] if isinstance(records, list) else []
    index = {(row.get("source_kind"), str(row.get("pk"))): _mapping(row.get("values")) for row in records
             if isinstance(row.get("source_kind"), str)}
    outlet = index.get(("OUTLET", str(demand.get("OUTLET_ID"))), {})
    supplier = index.get(("SUPPLIER", str(demand.get("SUPPLIER_ID"))), {})
    category = index.get(("CARGO_CATEGORY", str(demand.get("CARGO_CATEGORY_ID"))), {})
    items = []
    for (kind, pk), line in index.items():
        if kind != "DEMAND_ITEM" or str(line.get("DEMAND_ID")) != str(demand_id):
            continue
        item = index.get(("ITEM", str(line.get("ITEM_ID"))), {})
        items.append({
            "demand_item_id": pk,
            "item_id": _text(line.get("ITEM_ID")),
            "item_code": _text(item.get("ITEM_CODE")),
            "item_name": _text(item.get("ITEM_NAME")),
            "required_weight_kg": _text(line.get("REQUIRED_WEIGHT_KG")),
        })

    return {
        "demand_code": _text(demand.get("DEMAND_CODE")),
        "outlet_id": _text(demand.get("OUTLET_ID")),
        "outlet_code": _text(outlet.get("OUTLET_CODE")),
        "outlet_name": _text(outlet.get("OUTLET_NAME")),
        "supplier_code": _text(supplier.get("SUPPLIER_CODE")),
        "supplier_name": _text(supplier.get("SUPPLIER_NAME")),
        "cargo_category_code": _text(category.get("CATEGORY_CODE")),
        "status": _text(demand.get("STATUS")),
        "quantity_kg": _text(demand.get("QUANTITY_KG")),
        "requested_date": _text(demand.get("REQUESTED_DATE")),
        "requested_start_time": _text(demand.get("REQUESTED_START_TIME")),
        "requested_end_time": _text(demand.get("REQUESTED_END_TIME")),
        "captured_at": _text(snapshot.get("captured_at")),
        "snapshot_version": _text(snapshot.get("schema_version")),
        "items": items or None,
        "promise_shortfalls": _shortfalls(snapshot) if show_shortfall else None,
    }


def describe_run_configuration(snapshot):
    snapshot = _mapping(snapshot)
    rules = _mapping(snapshot.get("rule_set"))
    matrix = _mapping(snapshot.get("cargo_compatibility_matrix"))
    parameters = _mapping(snapshot.get("parameters"))

    def limit(key):
        value = _mapping(parameters.get(key)).get("value")
        return value if type(value) is int else None

    version = rules.get("version_no")
    return {
        "rule_set_code": _text(rules.get("code")),
        "rule_set_version": version if type(version) is int else None,
        "configuration_captured_at": _text(snapshot.get("captured_at")),
        "cargo_matrix_source": _text(matrix.get("source")),
        "cargo_matrix_sheet": _text(matrix.get("sheet")),
        "max_group_size": limit("max_group_size"),
        "max_candidates_per_run": limit("max_candidates_per_run"),
    }
