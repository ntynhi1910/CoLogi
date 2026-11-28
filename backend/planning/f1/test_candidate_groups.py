
"""Unit tests for pure F1 Candidate Group generation."""

import unittest
from datetime import date, time, timezone

from planning.f1.candidate_groups import (
    CandidateLimitExceeded,
    CandidateDemandInput,
    generate_candidate_groups,
)
from planning.f1.eligibility import EligibilityStatus

from planning.f1.cargo_compatibility import (
    dataset_v7_cargo_compatibility_rows,
    normalize_cargo_compatibility_matrix,
)
class CandidateGroupTests(unittest.TestCase):
    def setUp(self):
        self.delivery_date = date(2026, 11, 20)
        self.cargo_compatibility_matrix = (
            normalize_cargo_compatibility_matrix(
                dataset_v7_cargo_compatibility_rows()
            )
        )

    def generate(self, demands):
        return generate_candidate_groups(
            demands,
            cargo_compatibility_matrix=self.cargo_compatibility_matrix,
        )

    def bounded(self, demands, size, limit):
        return generate_candidate_groups(
            demands,
            cargo_compatibility_matrix=self.cargo_compatibility_matrix,
            max_group_size=size,
            max_candidates_per_run=limit,
        )

    def test_bounded_maximal_groups_and_exact_limit(self):
        demands = [self.demand(i) for i in range(1, 6)]
        groups = self.bounded(demands, 4, 5)
        self.assertEqual([g.demand_ids for g in groups], [
            (1, 2, 3, 4), (1, 2, 3, 5), (1, 2, 4, 5),
            (1, 3, 4, 5), (2, 3, 4, 5),
        ])
        self.assertEqual(groups, self.bounded(reversed(demands), 4, 5))
        with self.assertRaisesRegex(CandidateLimitExceeded, "CANDIDATE_LIMIT_EXCEEDED"):
            self.bounded(demands, 4, 4)

    def test_duplicate_bounded_candidate_counts_only_once(self):
        # Two overlapping maximal cliques {1,2,3}, {1,2,4}.
        demands = [self.demand(1), self.demand(2),
                   self.demand(3, end=time(10)),
                   self.demand(4, start=time(10))]
        groups = self.bounded(demands, 2, 5)
        self.assertEqual([g.demand_ids for g in groups], [
            (1, 2), (1, 3), (1, 4), (2, 3), (2, 4),
        ])
        with self.assertRaises(CandidateLimitExceeded):
            self.bounded(demands, 2, 4)

    def test_cp15_unlimited_group_size(self):
        for count in (5, 8, 10, 20):
            with self.subTest(count=count):
                demands = [
                    self.demand(i)
                    for i in range(1, count + 1)
                ]
                groups = self.bounded(demands, None, 100)
                self.assertEqual(
                    [g.demand_ids for g in groups],
                    [tuple(range(1, count + 1))],
                )

    def test_cp15_candidate_count_limit_is_retained(self):
        demands = [
            self.demand(1),
            self.demand(2),
            self.demand(3, requested_date=date(2026, 11, 21)),
            self.demand(4, requested_date=date(2026, 11, 21)),
        ]
        with self.assertRaises(CandidateLimitExceeded):
            self.bounded(demands, None, 1)

    def test_invalid_bounds_rejected(self):
        for size, limit in [(1, 2), (True, 2), (2, 0), (2, True),
                            (2, None), (None, 0), ("2", 2)]:
            with self.subTest(size=size, limit=limit), self.assertRaises(ValueError):
                self.bounded([], size, limit)

    def test_limit_applies_across_dates(self):
        demands = [self.demand(1), self.demand(2),
                   self.demand(3, requested_date=date(2026, 11, 21)),
                   self.demand(4, requested_date=date(2026, 11, 21))]
        with self.assertRaises(CandidateLimitExceeded):
            self.bounded(demands, 2, 1)

    def demand(
        self,
        demand_id,
        start=time(8, 0),
        end=time(12, 0),
        *,
        status=EligibilityStatus.ELIGIBLE,
        requested_date=None,
        cargo_category_id=1,
        outlet_id=None,
    ):
        return CandidateDemandInput(
            demand_id=demand_id,
            outlet_id=outlet_id if outlet_id is not None else demand_id,
            eligibility_status=status,
            requested_date=(
                requested_date
                if requested_date is not None
                else self.delivery_date
            ),
            cargo_category_id=cargo_category_id,
            requested_start_time=start,
            requested_end_time=end,
            
        )

    def test_generates_only_the_maximal_group_when_all_demands_are_compatible(self):
        demands = [
            self.demand(1),
            self.demand(2),
            self.demand(3),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 2, 3)],
        )

    def test_demand_can_appear_in_multiple_candidate_groups(self):
        demands = [
            self.demand(1, start=time(8, 0), end=time(12, 0)),
            self.demand(2, start=time(8, 0), end=time(10, 0)),
            self.demand(3, start=time(10, 0), end=time(12, 0)),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 2), (1, 3)],
        )
        self.assertTrue(all(1 in group.demand_ids for group in groups))

    def test_only_eligible_demands_are_grouped(self):
        demands = [
            self.demand(1),
            self.demand(
                2,
                status=EligibilityStatus.EXCLUDED,
            ),
            self.demand(3),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 3)],
        )

    def test_different_dates_are_not_grouped(self):
        demands = [
            self.demand(1),
            self.demand(
                2,
                requested_date=date(2026, 11, 21),
            ),
        ]

        self.assertEqual(self.generate(demands), ())

    def test_different_cargo_categories_are_not_grouped(self):
        demands = [
            self.demand(1, cargo_category_id=1),
            self.demand(2, cargo_category_id=2),
        ]

        self.assertEqual(self.generate(demands), ())

    def test_missing_demand_window_excludes_demand_from_grouping(self):
        demands = [
            self.demand(1),
            self.demand(2, start=None),
            self.demand(3),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 3)],
        )

    def test_invalid_demand_window_excludes_demand_from_grouping(self):
        demands = [
            self.demand(
                1,
                start=time(12, 0),
                end=time(8, 0),
            ),
            self.demand(2),
            self.demand(3),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(2, 3)],
        )

    def test_mixed_time_zone_awareness_fails_closed(self):
        demands = [
            self.demand(
                1,
                start=time(8, 0, tzinfo=timezone.utc),
                end=time(12, 0, tzinfo=timezone.utc),
            ),
            self.demand(2),
        ]

        self.assertEqual(self.generate(demands), ())

    def test_touching_endpoints_are_not_overlap(self):
        demands = [
            self.demand(
                1,
                start=time(8, 0),
                end=time(10, 0),
            ),
            self.demand(
                2,
                start=time(10, 0),
                end=time(12, 0),
            ),
        ]

        self.assertEqual(self.generate(demands), ())

    def test_common_intersection_is_calculated_for_entire_group(self):
        # Every pair overlaps, but all three do not share one common window.
        demands = [
            self.demand(
                1,
                start=time(8, 0),
                end=time(10, 0),
            ),
            self.demand(
                2,
                start=time(9, 0),
                end=time(11, 0),
            ),
            self.demand(
                3,
                start=time(10, 0),
                end=time(12, 0),
            ),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 2), (2, 3)],
        )

    def test_common_intersection_values_are_returned(self):
        demands = [
            self.demand(
                1,
                start=time(8, 0),
                end=time(11, 0),
            ),
            self.demand(
                2,
                start=time(9, 0),
                end=time(12, 0),
            ),
            self.demand(
                3,
                start=time(9, 30),
                end=time(10, 30),
            ),
        ]

        groups = self.generate(demands)

        triple = next(
            group
            for group in groups
            if group.demand_ids == (1, 2, 3)
        )

        self.assertEqual(triple.common_start_time, time(9, 30))
        self.assertEqual(triple.common_end_time, time(10, 30))

    def test_single_demand_does_not_create_group(self):
        self.assertEqual(
            self.generate([self.demand(1)]),
            (),
        )

    def test_output_is_deterministic_regardless_of_input_order(self):
        demands = [
            self.demand(3),
            self.demand(1),
            self.demand(2),
        ]

        first = self.generate(demands)
        second = self.generate(reversed(demands))

        self.assertEqual(first, second)

    def test_duplicate_demand_ids_raise_value_error(self):
        demands = [
            self.demand(1),
            self.demand(1),
        ]

        with self.assertRaises(ValueError):
            self.generate(demands)

    def test_invalid_demand_id_raises_value_error(self):
        with self.assertRaises(ValueError):
            self.generate([self.demand(0)])

    def test_invalid_cargo_category_id_raises_value_error(self):
        with self.assertRaises(ValueError):
            self.generate([
                self.demand(1, cargo_category_id=0)
            ])

    def test_empty_input_returns_no_groups(self):
        self.assertEqual(self.generate([]), ())

    def test_same_outlet_demands_do_not_form_candidate_group(self):
        demands = [
            self.demand(1, outlet_id=10),
            self.demand(2, outlet_id=10),
            self.demand(3, outlet_id=10),
        ]

        self.assertEqual(self.generate(demands), ())

    def test_candidate_group_requires_two_distinct_outlets(self):
        demands = [
            self.demand(1, outlet_id=10),
            self.demand(2, outlet_id=10),
            self.demand(3, outlet_id=20),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 2, 3)],
        )


    def test_canonical_key_is_sorted_demand_identity(self):
        groups = self.generate([
            self.demand(30),
            self.demand(10),
            self.demand(20),
        ])

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].demand_ids, (10, 20, 30))
        self.assertEqual(groups[0].canonical_key, (10, 20, 30))

    def test_maximal_groups_are_ordered_by_canonical_identity(self):
        demands = [
            self.demand(4, start=time(10, 0), end=time(12, 0)),
            self.demand(2, start=time(8, 0), end=time(10, 0)),
            self.demand(3, start=time(10, 0), end=time(12, 0)),
            self.demand(1, start=time(8, 0), end=time(10, 0)),
        ]

        groups = self.generate(demands)

        self.assertEqual(
            [group.demand_ids for group in groups],
            [(1, 2), (3, 4)],
        )

    def test_missing_cargo_pair_fails_closed(self):
        matrix = dict(self.cargo_compatibility_matrix)
        matrix.pop((1, 1))

        result = generate_candidate_groups(
            [self.demand(1), self.demand(2)],
            cargo_compatibility_matrix=matrix,
        )

        self.assertEqual(result, ())

    def test_invalid_outlet_id_is_rejected(self):
        with self.assertRaises(ValueError):
            self.generate([self.demand(1, outlet_id=0)])


if __name__ == "__main__":
    unittest.main()
