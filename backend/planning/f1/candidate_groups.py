"""Pure F1 Candidate Group generation.

Generates maximal valid groups of two or more eligible Demands.
No Django imports, database access, persistence, or I/O.
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time
from itertools import combinations

from planning.f1.cargo_compatibility import (
    evaluate_cargo_categories_compatibility,
)
from planning.f1.eligibility import EligibilityStatus
from planning.f1.time_eligibility import (
    IntersectionStatus,
    find_common_demand_pickup_window,
    validate_demand_pickup_window,
    WindowStatus,
)


@dataclass(frozen=True)
class CandidateDemandInput:
    """Minimal, ORM-independent input for Candidate Group generation."""

    demand_id: int
    outlet_id: int
    eligibility_status: EligibilityStatus | str
    requested_date: date | None
    cargo_category_id: int
    requested_start_time: time | None
    requested_end_time: time | None


@dataclass(frozen=True)
class CandidateGroup:
    """One maximal group with a strict common Demand pickup window.

    ``demand_ids`` is sorted and is the canonical, stable identity of the
    in-memory Candidate Group. Persistence may later map this tuple to a
    database identifier without changing the F1 grouping contract.
    """

    demand_ids: tuple[int, ...]
    requested_date: date
    cargo_category_ids: tuple[int, ...]
    common_start_time: time
    common_end_time: time

    @property
    def canonical_key(self) -> tuple[int, ...]:
        """Return the canonical identity independent of input ordering."""
        return self.demand_ids


class CandidateLimitExceeded(ValueError):
    """The first unique candidate beyond the configured limit was found."""

    def __init__(self):
        super().__init__("CANDIDATE_LIMIT_EXCEEDED")


def validate_candidate_limits(max_group_size, max_candidates_per_run):
    # None size means no cardinality cap.
    # None/None remains supported for legacy preview callers.
    if max_group_size is None and max_candidates_per_run is None:
        return
    if max_group_size is not None and (
        type(max_group_size) is not int or max_group_size < 2
    ):
        raise ValueError("INVALID_MAX_GROUP_SIZE")
    if type(max_candidates_per_run) is not int or max_candidates_per_run < 1:
        raise ValueError("INVALID_MAX_CANDIDATES_PER_RUN")


def _demands_are_pairwise_compatible(
    left: CandidateDemandInput,
    right: CandidateDemandInput,
    *,
    cargo_compatibility_matrix: Mapping,
) -> bool:
    """Return whether two Demands can coexist in one Candidate Group."""
    compatibility = evaluate_cargo_categories_compatibility(
        (left.cargo_category_id, right.cargo_category_id),
        cargo_compatibility_matrix,
    )
    if not compatibility.is_compatible:
        return False

    try:
        intersection = find_common_demand_pickup_window((
            (
                left.requested_date,
                left.requested_start_time,
                left.requested_end_time,
            ),
            (
                right.requested_date,
                right.requested_start_time,
                right.requested_end_time,
            ),
        ))
    except TypeError:
        # Incompatible time-zone awareness cannot establish a common window.
        return False

    return intersection.status is IntersectionStatus.COMPATIBLE


def _maximal_cliques(adjacency: tuple[frozenset[int], ...]):
    """Yield maximal cliques using deterministic Bron–Kerbosch pivoting."""
    def visit(
        selected: frozenset[int],
        possible: set[int],
        excluded: set[int],
    ):
        if not possible and not excluded:
            yield tuple(sorted(selected))
            return

        pivot_pool = possible | excluded
        pivot = (
            max(
                pivot_pool,
                key=lambda node: (len(possible & adjacency[node]), -node),
            )
            if pivot_pool
            else None
        )
        candidates = (
            sorted(possible - set(adjacency[pivot]))
            if pivot is not None
            else sorted(possible)
        )

        for node in candidates:
            neighbors = set(adjacency[node])
            yield from visit(
                selected | {node},
                possible & neighbors,
                excluded & neighbors,
            )
            possible.remove(node)
            excluded.add(node)

    yield from visit(
        frozenset(),
        set(range(len(adjacency))),
        set(),
    )


def _generate_maximal_groups_for_date(
    members: list[CandidateDemandInput],
    *,
    cargo_compatibility_matrix: Mapping,
    max_group_size: int | None = None,
):
    """Generate maximal valid groups for one date.

    Cargo compatibility and strict time overlap are pairwise constraints.
    Demand pickup windows are intervals on one time axis, so the interval
    Helly property guarantees that pairwise strict overlap implies one common
    intersection across the entire clique. Maximal cliques therefore map to
    maximal Candidate Groups. Pivoting avoids enumerating every subgroup when
    many Demands are mutually compatible.
    """
    members.sort(key=lambda demand: demand.demand_id)
    adjacency = [set() for _ in members]

    for left_index in range(len(members)):
        for right_index in range(left_index + 1, len(members)):
            if _demands_are_pairwise_compatible(
                members[left_index],
                members[right_index],
                cargo_compatibility_matrix=cargo_compatibility_matrix,
            ):
                adjacency[left_index].add(right_index)
                adjacency[right_index].add(left_index)

    frozen_adjacency = tuple(
        frozenset(neighbors) for neighbors in adjacency
    )
    for clique in _maximal_cliques(frozen_adjacency):
        # Every bounded maximal group is either a full maximal clique below
        # the cap, or a size-cap subset of one. Deduplication is global.
        bounded_cliques = (
            combinations(clique, max_group_size)
            if max_group_size is not None and len(clique) > max_group_size
            else (clique,)
        )
        for bounded_clique in bounded_cliques:
            group = _build_group(members, bounded_clique)
            if group is not None:
                yield group


def _build_group(members, clique):
    selected = tuple(members[index] for index in clique)
    if len(selected) < 2:
        return None
    if len({demand.outlet_id for demand in selected}) < 2:
        return None

    intersection = find_common_demand_pickup_window(
        (
            demand.requested_date,
            demand.requested_start_time,
            demand.requested_end_time,
        )
        for demand in selected
    )
    if (
        intersection.status is not IntersectionStatus.COMPATIBLE
        or intersection.requested_date is None
        or intersection.start_time is None
        or intersection.end_time is None
    ):
        return None

    return CandidateGroup(
        demand_ids=tuple(sorted(demand.demand_id for demand in selected)),
        requested_date=intersection.requested_date,
        cargo_category_ids=tuple(sorted({d.cargo_category_id for d in selected})),
        common_start_time=intersection.start_time,
        common_end_time=intersection.end_time,
    )


def generate_candidate_groups(
    demands: Iterable[CandidateDemandInput],
    *,
    cargo_compatibility_matrix: Mapping,
    max_group_size: int | None = None,
    max_candidates_per_run: int | None = None,
) -> tuple[CandidateGroup, ...]:
    """Generate maximal valid groups using a frozen compatibility matrix.

    Rules:
    - Only ELIGIBLE Demands are considered.
    - Members share one requested date.
    - Every distinct Cargo Category pair must be configured and compatible.
    - Every group contains at least two distinct Outlets.
    - Every member has a valid Demand requested time window.
    - The whole group has a strict common time intersection.
    - Only maximal valid groups are returned; maximal groups may overlap.
    - ``demand_ids`` is the sorted canonical group identity.

    The matrix must already be normalized by
    normalize_cargo_compatibility_matrix(). Missing pairs fail closed.
    A None group size permits unrestricted maximal groups.
    Configured execution still requires a positive candidate count limit.
    Overflow raises before any partial result is returned.
    """
    validate_candidate_limits(max_group_size, max_candidates_per_run)
    if (
        not isinstance(cargo_compatibility_matrix, Mapping)
        or not cargo_compatibility_matrix
    ):
        raise ValueError("CARGO_COMPATIBILITY_MATRIX_MISSING")

    eligible_demands: list[CandidateDemandInput] = []
    seen_demand_ids: set[int] = set()

    for demand in demands:
        if (
            isinstance(demand.demand_id, bool)
            or not isinstance(demand.demand_id, int)
            or demand.demand_id <= 0
        ):
            raise ValueError("demand_id must be a positive integer")

        if demand.demand_id in seen_demand_ids:
            raise ValueError(f"duplicate demand_id: {demand.demand_id}")
        seen_demand_ids.add(demand.demand_id)

        if (
            isinstance(demand.outlet_id, bool)
            or not isinstance(demand.outlet_id, int)
            or demand.outlet_id <= 0
        ):
            raise ValueError("outlet_id must be a positive integer")

        if (
            isinstance(demand.cargo_category_id, bool)
            or not isinstance(demand.cargo_category_id, int)
            or demand.cargo_category_id <= 0
        ):
            raise ValueError("cargo_category_id must be a positive integer")

        if demand.eligibility_status != EligibilityStatus.ELIGIBLE:
            continue

        requested_date = demand.requested_date
        if (
            not isinstance(requested_date, date)
            or isinstance(requested_date, datetime)
        ):
            continue

        window = validate_demand_pickup_window(
            requested_date,
            demand.requested_start_time,
            demand.requested_end_time,
        )
        if window.status is not WindowStatus.VALID:
            continue

        eligible_demands.append(demand)

    partitions: dict[date, list[CandidateDemandInput]] = {}
    for demand in eligible_demands:
        partitions.setdefault(demand.requested_date, []).append(demand)

    candidate_groups: dict[tuple[int, ...], CandidateGroup] = {}
    for requested_date in sorted(partitions):
        for group in _generate_maximal_groups_for_date(
                partitions[requested_date],
                cargo_compatibility_matrix=cargo_compatibility_matrix,
                max_group_size=max_group_size,
        ):
            if group.canonical_key in candidate_groups:
                continue
            if (max_candidates_per_run is not None
                    and len(candidate_groups) >= max_candidates_per_run):
                raise CandidateLimitExceeded()
            candidate_groups[group.canonical_key] = group

    return tuple(
        sorted(
            candidate_groups.values(),
            key=lambda group: (group.requested_date, group.demand_ids),
        )
    )
