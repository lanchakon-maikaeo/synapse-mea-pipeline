"""Declarative data-quality expectations (candidate, dependency-light).

SYNAPSE hand-rolls checksum / lineage / quarantine / validation. This module
adds the missing piece the Great Expectations / Soda / dbt-tests ecosystem
provides: a *declarative* expectation suite plus a machine-readable report that
doubles as data-contract evidence -- without pulling in a heavy framework or a
new dependency. The same suite can later be expressed in Great Expectations or
Soda Core if the team adopts one; this keeps the contract explicit meanwhile.

A suite is a list of expectations evaluated against a dataset given as a list of
row mappings. Each expectation yields an ``ExpectationResult`` (success, observed
value, detail), and ``run_suite`` aggregates them into a ``DataQualityReport``
that is JSON-serialisable for evidence storage.

Candidate analytics; see ``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md``. It validates
and reports -- it does not quarantine or mutate data on its own.

Reference: Great Expectations / Soda Core / dbt tests declarative data contracts.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Callable, Mapping, Sequence

Row = Mapping[str, Any]


@dataclass(frozen=True)
class ExpectationResult:
    expectation: str
    column: str | None
    success: bool
    observed: Any
    detail: str


@dataclass(frozen=True)
class DataQualityReport:
    total: int
    passed: int
    failed: int
    results: tuple[ExpectationResult, ...]

    @property
    def success(self) -> bool:
        return self.failed == 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "success": self.success,
            "results": [
                {
                    "expectation": result.expectation,
                    "column": result.column,
                    "success": result.success,
                    "observed": result.observed,
                    "detail": result.detail,
                }
                for result in self.results
            ],
        }


@dataclass(frozen=True)
class Expectation:
    name: str
    column: str | None
    check: Callable[[Sequence[Row]], ExpectationResult]


def _values(rows: Sequence[Row], column: str) -> list[Any]:
    return [row.get(column) for row in rows]


def expect_column_exists(column: str) -> Expectation:
    def check(rows: Sequence[Row]) -> ExpectationResult:
        missing = sum(1 for row in rows if column not in row)
        return ExpectationResult(
            "column_exists", column, missing == 0, missing,
            "all rows contain the column" if missing == 0 else f"{missing} rows missing the column",
        )

    return Expectation("column_exists", column, check)


def expect_not_null(column: str) -> Expectation:
    def check(rows: Sequence[Row]) -> ExpectationResult:
        nulls = sum(1 for value in _values(rows, column) if value is None)
        return ExpectationResult(
            "not_null", column, nulls == 0, nulls,
            "no nulls" if nulls == 0 else f"{nulls} null values",
        )

    return Expectation("not_null", column, check)


def expect_unique(column: str) -> Expectation:
    def check(rows: Sequence[Row]) -> ExpectationResult:
        values = [value for value in _values(rows, column) if value is not None]
        duplicates = len(values) - len(set(values))
        return ExpectationResult(
            "unique", column, duplicates == 0, duplicates,
            "all values unique" if duplicates == 0 else f"{duplicates} duplicate values",
        )

    return Expectation("unique", column, check)


def expect_in_set(column: str, allowed: Sequence[Any]) -> Expectation:
    allowed_set = set(allowed)

    def check(rows: Sequence[Row]) -> ExpectationResult:
        violations = [value for value in _values(rows, column) if value is not None and value not in allowed_set]
        return ExpectationResult(
            "in_set", column, not violations, len(violations),
            "all values in allowed set" if not violations else f"{len(violations)} values outside allowed set",
        )

    return Expectation("in_set", column, check)


def expect_between(column: str, minimum: float | None = None, maximum: float | None = None) -> Expectation:
    def check(rows: Sequence[Row]) -> ExpectationResult:
        violations = 0
        for value in _values(rows, column):
            if value is None:
                continue
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                violations += 1
                continue
            if minimum is not None and numeric < minimum:
                violations += 1
            elif maximum is not None and numeric > maximum:
                violations += 1
        return ExpectationResult(
            "between", column, violations == 0, violations,
            "all values within range" if violations == 0 else f"{violations} values out of range",
        )

    return Expectation("between", column, check)


def expect_non_negative(column: str) -> Expectation:
    return Expectation("non_negative", column, expect_between(column, minimum=0.0).check)


def expect_matches_regex(column: str, pattern: str) -> Expectation:
    compiled = re.compile(pattern)

    def check(rows: Sequence[Row]) -> ExpectationResult:
        violations = sum(
            1 for value in _values(rows, column)
            if value is not None and compiled.fullmatch(str(value)) is None
        )
        return ExpectationResult(
            "matches_regex", column, violations == 0, violations,
            "all values match pattern" if violations == 0 else f"{violations} values fail the pattern",
        )

    return Expectation("matches_regex", column, check)


def expect_row_count_between(minimum: int | None = None, maximum: int | None = None) -> Expectation:
    def check(rows: Sequence[Row]) -> ExpectationResult:
        count = len(rows)
        ok = (minimum is None or count >= minimum) and (maximum is None or count <= maximum)
        return ExpectationResult(
            "row_count_between", None, ok, count,
            f"row count {count} within bounds" if ok else f"row count {count} outside bounds",
        )

    return Expectation("row_count_between", None, check)


def expect_foreign_key(column: str, reference: Sequence[Any]) -> Expectation:
    reference_set = set(reference)

    def check(rows: Sequence[Row]) -> ExpectationResult:
        violations = [value for value in _values(rows, column) if value is not None and value not in reference_set]
        return ExpectationResult(
            "foreign_key", column, not violations, len(violations),
            "all keys present in reference" if not violations else f"{len(violations)} orphan keys",
        )

    return Expectation("foreign_key", column, check)


def run_suite(rows: Sequence[Row], suite: Sequence[Expectation]) -> DataQualityReport:
    results = tuple(expectation.check(rows) for expectation in suite)
    passed = sum(1 for result in results if result.success)
    return DataQualityReport(
        total=len(results),
        passed=passed,
        failed=len(results) - passed,
        results=results,
    )
