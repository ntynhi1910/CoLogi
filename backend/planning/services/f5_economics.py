"""Decimal calculations for approved, scoped F5 price evidence."""

from collections import defaultdict
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP


RULES = {
    "RULE-20": {"expression": "baseline sum", "rule_type": "C"},
    "RULE-21": {"expression": "saving formula", "rule_type": "C"},
    "RULE-22": {"expression": "guard divide by zero", "rule_type": "C"},
    "RULE-23": {"expression": "method in WEIGHT,ORDER_COUNT", "rule_type": "C"},
    "RULE-24": {"expression": "sum allocation = collaborative cost +/- rounding", "rule_type": "B"},
    "RULE-25": {"expression": "participant_saving < 0 => warning", "rule_type": "W"},
}
ZERO = Decimal(0)
TRANSPORT = {"TRANSPORT_BASE", "DISTANCE"}
DISTANCE_BASIS = {"FIRST_SERVICE_TO_LAST_SERVICE", "INCLUDING_DEPOT"}


class PriceInvalid(Exception):
    def __init__(self, code, **details):
        self.diagnostic = {"code": code, **details}
        super().__init__(code)


def sum_money(values):
    return sum(values, ZERO)


def round_money(value, unit):
    return (value / unit).quantize(Decimal(1), rounding=ROUND_HALF_UP) * unit


def _applies(quote, day):
    if not quote["valid_from"] <= day <= quote["valid_to"]:
        raise PriceInvalid("PRICE_OUTSIDE_EFFECTIVE_DATE", reference=quote["source_reference"])


def _calculate(quote, *, day, unit, quantities, scope, wave_no=None, categories, required_coverage):
    _applies(quote, day)
    seen, result = set(), []
    for component in quote["components"]:
        coverage, basis = set(component["covers"]), component["pricing_basis"]
        if seen & coverage:
            raise PriceInvalid("PRICE_COMPONENTS_OVERLAP", reference=quote["source_reference"])
        if not coverage <= categories or (len(coverage) > 1 and basis != "BUNDLED"):
            raise PriceInvalid("PRICE_COMPONENT_SCOPE_INVALID", reference=quote["source_reference"])
        if basis == "PER_KM" and coverage != {"DISTANCE"}:
            raise PriceInvalid("PRICE_COMPONENT_SCOPE_INVALID", reference=quote["source_reference"])
        if basis == "OTHER" and coverage != {component.get("measure")}:
            raise PriceInvalid("PRICE_COMPONENT_SCOPE_INVALID", reference=quote["source_reference"])
        seen.update(coverage)
        quantity, unit_code = {
            "FIXED": (Decimal(1), "TRIP" if wave_no else "CHARGE"),
            "BUNDLED": (Decimal(1), "BUNDLE"),
            "PER_KM": (quantities.get("distance_km"), "KM"),
            "PER_KG": (quantities["weight_kg"], "KG"),
            "PER_ORDER": (quantities["orders"], "ORDER"),
            "OTHER": (quantities.get(component.get("measure")), "MIN"),
        }[basis]
        if quantity is None:
            code = "INDEPENDENT_DISTANCE_REQUIRED" if scope.startswith("DEMAND/") else "PRICE_QUANTITY_REQUIRED"
            raise PriceInvalid(code, scope=scope, unit=unit_code)
        rate = Decimal(component["rate_vnd"])
        raw = quantity * rate
        result.append({
            "component_type": "TRANSPORT" if coverage & TRANSPORT else (
                "HUB_HANDLING" if "HUB_HANDLING" in coverage else "HANDLING" if "STOP_HANDLING" in coverage else "OTHER"
            ),
            "wave_no": wave_no, "scope": scope, "pricing_basis": basis, "covers": sorted(coverage),
            "quantity": quantity, "unit_code": unit_code, "unit_rate": rate, "raw_amount": raw,
            "amount": round_money(raw, unit), "source_type": quote["source_type"],
            "source_reference": quote["source_reference"], "valid_from": quote["valid_from"], "valid_to": quote["valid_to"],
            "formula": "quantity × rate; ROUND_HALF_UP to configured VND unit",
        })
    if seen.isdisjoint(required_coverage):
        raise PriceInvalid("PRICE_COMPONENT_SCOPE_INVALID", reference=quote["source_reference"])
    return result, seen


def _distance_with_depot(quote, route_distance, distance_basis, scope):
    if distance_basis == "FIRST_SERVICE_TO_LAST_SERVICE":
        return route_distance, None
    depot = quote.get("depot")
    if not depot:
        raise PriceInvalid("DEPOT_DISTANCE_REQUIRED", scope=scope)
    return route_distance + Decimal(depot["to_pickup_km"]) + Decimal(depot["return_km"]), depot


def wave_inputs(result):
    return [{
        "wave_no": row["wave_no"], "phase": row["phase"], "offer_id": row["vehicle"]["offer_id"],
        "demand_ids": row["demand_ids"], "weight_kg": row["weight_kg"],
        "distance_km": sum_money(Decimal(stop["travel_from_previous"]["distance_km"])
                                for stop in row["stops"] if stop["travel_from_previous"]),
        "wait_minutes": sum_money(Decimal(str(stop["wait_minutes"])) for stop in row["stops"]),
        "handling_minutes": sum_money(Decimal(stop["evidence"]["service"]["minutes"]) for stop in row["stops"]
                                      if stop["role"] not in ("HUB_RECEIVE", "HUB_DISPATCH")),
    } for row in result["waves"]]


def collaborative_cost(basis, waves, hub_id, option, config):
    day, unit = basis["requested_date"], Decimal(config["rounding_unit_vnd"])
    prices = {row["wave_no"]: row for row in option["waves"]}
    if len(prices) != len(option["waves"]) or set(prices) != {row["wave_no"] for row in waves}:
        raise PriceInvalid("WAVE_QUOTE_SET_MISMATCH")
    rows, hub_in_bundle = [], 0
    for wave in waves:
        no = wave["wave_no"]
        quote = prices[no]
        scope = f"WAVE/{no}"
        if quote["offer_id"] != wave["offer_id"]:
            raise PriceInvalid("WAVE_QUOTE_OFFER_MISMATCH", wave_no=no)
        distance, depot = _distance_with_depot(quote, wave["distance_km"], config["distance_basis"], scope)
        quantities = {
            "distance_km": distance, "weight_kg": Decimal(wave["weight_kg"]), "orders": Decimal(len(wave["demand_ids"])),
            "WAIT": wave["wait_minutes"], "STOP_HANDLING": wave["handling_minutes"],
        }
        components, covered = _calculate(
            quote, day=day, unit=unit, quantities=quantities, scope=scope, wave_no=no,
            categories=TRANSPORT | {"WAIT", "STOP_HANDLING", "SURCHARGE"} | ({"HUB_HANDLING"} if hub_id else set()),
            required_coverage=TRANSPORT,
        )
        if any("HUB_HANDLING" in c["covers"] and c["pricing_basis"] != "BUNDLED" for c in components):
            raise PriceInvalid("HUB_CHARGE_MUST_BE_PLAN_SCOPED", wave_no=no)
        hub_in_bundle += int("HUB_HANDLING" in covered)
        rows.extend({**component, "distance_evidence": {
            "scope": config["distance_basis"], "snapshot_km": wave["distance_km"], "depot": depot,
        }} for component in components)
    hub = option.get("hub")
    if hub_in_bundle > 1 or (hub and hub_in_bundle):
        raise PriceInvalid("PRICE_COMPONENTS_OVERLAP", scope="HUB")
    if hub_id and not hub and not hub_in_bundle:
        raise PriceInvalid("HUB_PRICE_REQUIRED", hub_id=hub_id)
    if hub:
        if hub["hub_id"] != hub_id:
            raise PriceInvalid("HUB_PRICE_SCOPE_MISMATCH")
        components, _ = _calculate(
            hub, day=day, unit=unit, scope=f"HUB/{hub_id}", categories={"HUB_HANDLING"},
            required_coverage={"HUB_HANDLING"}, quantities={
                "weight_kg": Decimal(basis["total_required_weight_kg"]), "orders": Decimal(len(basis["demands"])),
            },
        )
        rows.extend(components)
    return rows


def independent_costs(basis, inputs, config):
    prices = {row["demand_id"]: row for row in inputs}
    demands = basis["demands"]
    if len(prices) != len(inputs) or set(prices) != {row["id"] for row in demands}:
        missing = [row["code"] for row in demands if row["id"] not in prices]
        raise PriceInvalid("INDEPENDENT_BASELINE_SET_MISMATCH", demand_codes=missing)
    rows = []
    for demand in demands:
        quote = prices[demand["id"]]
        scope = f"DEMAND/{demand['code']}"
        if quote["outlet_id"] != demand["outlet_id"] or Decimal(quote["weight_kg"]) != Decimal(demand["required_weight_kg"]):
            raise PriceInvalid("INDEPENDENT_BASELINE_SCOPE_MISMATCH", scope=scope)
        evidence = quote.get("independent_distance")
        if evidence and evidence["scope"] != config["distance_basis"]:
            raise PriceInvalid("INDEPENDENT_BASELINE_SCOPE_MISMATCH", scope=scope)
        components, _ = _calculate(
            quote, day=basis["requested_date"], unit=Decimal(config["rounding_unit_vnd"]), scope=scope,
            categories=TRANSPORT | {"WAIT", "STOP_HANDLING", "SURCHARGE"}, required_coverage=TRANSPORT,
            quantities={
                "distance_km": Decimal(evidence["distance_km"]) if evidence else None,
                "weight_kg": Decimal(demand["required_weight_kg"]), "orders": Decimal(1),
                "WAIT": Decimal(quote["wait_minutes"]) if "wait_minutes" in quote else None,
                "STOP_HANDLING": Decimal(quote["handling_minutes"]) if "handling_minutes" in quote else None,
            },
        )
        rows.append({
            "demand_id": demand["id"], "demand_code": demand["code"], "outlet_id": demand["outlet_id"],
            "outlet_code": demand["outlet_code"], "weight_kg": Decimal(demand["required_weight_kg"]),
            "distance_evidence": evidence, "components": components, "amount": sum_money(c["amount"] for c in components),
        })
    return rows


def savings(baseline, total):
    saving = baseline - total
    return saving, (saving * 100 / baseline).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP) if baseline > 0 else None


def allocate(baselines, total, config):
    by_outlet = defaultdict(list)
    for row in baselines:
        by_outlet[row["outlet_id"]].append(row)
    rows = [{
        "outlet_id": outlet, "outlet_code": parts[0]["outlet_code"], "order_count": len(parts),
        "weight_kg": sum_money(row["weight_kg"] for row in parts),
        "baseline_cost": sum_money(row["amount"] for row in parts),
    } for outlet, parts in sorted(by_outlet.items())]
    unit = Decimal(config["rounding_unit_vnd"])
    key = "weight_kg" if config["allocation_method"] == "WEIGHT" else "order_count"
    denominator = sum_money(row[key] for row in rows)
    for row in rows:
        # Divide in currency units. divmod keeps the remainder exact even for repeating shares.
        whole, remainder = divmod(total / unit * row[key], denominator)
        row["allocated_cost"] = whole * unit
        row["share_pct"] = (Decimal(row[key]) * 100 / denominator).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        row["_remainder"] = remainder
    remaining = int((total - sum_money(row["allocated_cost"] for row in rows)) / unit)
    for row in sorted(rows, key=lambda r: (-r["_remainder"], r["outlet_id"]))[:remaining]:
        row["allocated_cost"] += unit
    for row in rows:
        del row["_remainder"]
        row["participant_saving"] = row["baseline_cost"] - row["allocated_cost"]
    return rows


def recommend(options):
    eligible = sorted((row for row in options if row["status"] == "EVALUATED"),
                      key=lambda row: (row["collaborative_cost"], row["plan"]["plan_code"]))
    if not eligible:
        return {"status": "NOT_EVALUATED", "plan_codes": [], "reason": "COMPARABLE_COST_EVIDENCE_REQUIRED"}
    totals = sorted({row["collaborative_cost"] for row in eligible})
    for row in eligible:
        row["rank"] = totals.index(row["collaborative_cost"]) + 1
        row["ranking_reason"] = "MINIMUM_COMPARABLE_COST" if row["rank"] == 1 else "HIGHER_COMPARABLE_COST"
    best = [row["plan"]["plan_code"] for row in eligible if row["rank"] == 1]
    return {
        "status": "TIE" if len(best) > 1 else "SINGLE_EVALUATED" if len(eligible) == 1 else "RECOMMENDED",
        "plan_codes": best, "reason": "MINIMUM_COMPARABLE_COST",
    }
