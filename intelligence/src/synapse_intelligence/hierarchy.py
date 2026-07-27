"""Coherent hierarchical forecast reconciliation (candidate, dependency-light).

SYNAPSE forecasts each ``material x district`` series on its own, so the district
forecasts need not sum to the material total that the central warehouse must
actually replenish. Reconciliation makes the levels coherent: the reconciled
district forecasts sum exactly to the reconciled total.

Two methods, both pure-Python and deterministic (no NumPy/SciPy):

- ``reconcile_bottom_up`` -- sum the leaf forecasts up the tree. Simple and
  always coherent, but ignores the information in the aggregate forecast.
- ``reconcile_min_trace`` -- the MinT projection (``ols`` or ``wls_struct``),
  which optimally combines every level's base forecast into a coherent set and
  generally lowers error versus using any single level alone.

This is the SYNAPSE-native analogue of Nixtla ``HierarchicalForecast``; see
``docs/RESEARCH_DRIVEN_IMPROVEMENTS.md``. It is candidate analytics and is not
wired into the frozen replenishment path.

Reference: Wickramasuriya, Athanasopoulos & Hyndman, "Optimal forecast
reconciliation for hierarchical and grouped time series through trace
minimization" (JASA, 2019).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence


@dataclass(frozen=True)
class Hierarchy:
    """A single-level-or-deeper aggregation structure.

    ``members`` maps each aggregate node to the leaf nodes it sums. Aggregate
    order is preserved; leaves are sorted for a stable node order. ``nodes`` lists
    aggregates first, then leaves -- the row order of the summing matrix.
    """

    leaves: tuple[str, ...]
    aggregates: tuple[str, ...]
    members: Mapping[str, tuple[str, ...]]

    @property
    def nodes(self) -> tuple[str, ...]:
        return self.aggregates + self.leaves


def build_hierarchy(members: Mapping[str, Sequence[str]]) -> Hierarchy:
    if not members:
        raise ValueError("hierarchy requires at least one aggregate")
    leaves = tuple(sorted({leaf for group in members.values() for leaf in group}))
    if not leaves:
        raise ValueError("hierarchy requires at least one leaf")
    aggregates = tuple(members.keys())
    overlap = set(aggregates) & set(leaves)
    if overlap:
        raise ValueError(f"aggregate and leaf names must be disjoint: {sorted(overlap)}")
    normalized: dict[str, tuple[str, ...]] = {}
    for aggregate, group in members.items():
        group_leaves = tuple(group)
        if not group_leaves:
            raise ValueError(f"aggregate {aggregate!r} has no leaves")
        normalized[aggregate] = group_leaves
    return Hierarchy(leaves=leaves, aggregates=aggregates, members=normalized)


def summing_matrix(hierarchy: Hierarchy) -> list[list[float]]:
    """Rows over ``hierarchy.nodes``, columns over ``hierarchy.leaves``."""
    leaf_index = {leaf: column for column, leaf in enumerate(hierarchy.leaves)}
    matrix: list[list[float]] = []
    for aggregate in hierarchy.aggregates:
        row = [0.0] * len(hierarchy.leaves)
        for leaf in hierarchy.members[aggregate]:
            row[leaf_index[leaf]] = 1.0
        matrix.append(row)
    for leaf in hierarchy.leaves:
        row = [0.0] * len(hierarchy.leaves)
        row[leaf_index[leaf]] = 1.0
        matrix.append(row)
    return matrix


def reconcile_bottom_up(hierarchy: Hierarchy, base_leaf: Mapping[str, float]) -> dict[str, float]:
    missing = [leaf for leaf in hierarchy.leaves if leaf not in base_leaf]
    if missing:
        raise ValueError(f"missing base forecasts for leaves {missing}")
    result = {leaf: float(base_leaf[leaf]) for leaf in hierarchy.leaves}
    for aggregate in hierarchy.aggregates:
        result[aggregate] = sum(result[leaf] for leaf in hierarchy.members[aggregate])
    return result


def _solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    """Solve ``A x = b`` by Gaussian elimination with partial pivoting."""
    size = len(matrix)
    augmented = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda r: abs(augmented[r][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("reconciliation system is singular")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        pivot_value = augmented[column][column]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column] / pivot_value
            if factor == 0.0:
                continue
            for col in range(column, size + 1):
                augmented[row][col] -= factor * augmented[column][col]
    # Full elimination leaves a diagonal system, so back-substitution is a divide.
    return [augmented[index][size] / augmented[index][index] for index in range(size)]


def reconcile_min_trace(
    hierarchy: Hierarchy,
    base_all: Mapping[str, float],
    *,
    method: str = "ols",
    non_negative: bool = False,
) -> dict[str, float]:
    """MinT reconciliation. ``base_all`` holds a base forecast for every node.

    ``method="ols"`` weights all nodes equally; ``method="wls_struct"`` weights a
    node by the inverse of the number of leaves beneath it (a scale-free proxy
    for aggregation variance). With ``non_negative`` the reconciled leaves are
    clamped at zero and the aggregates recomputed bottom-up, keeping the result
    both coherent and non-negative.
    """
    nodes = hierarchy.nodes
    missing = [node for node in nodes if node not in base_all]
    if missing:
        raise ValueError(f"missing base forecasts for nodes {missing}")
    s_matrix = summing_matrix(hierarchy)
    y = [float(base_all[node]) for node in nodes]

    if method == "ols":
        weights = [1.0] * len(nodes)
    elif method == "wls_struct":
        weights = [1.0 / sum(row) for row in s_matrix]
    else:
        raise ValueError("method must be 'ols' or 'wls_struct'")

    leaf_count = len(hierarchy.leaves)
    # Normal equations for weighted least squares: (S^T W S) x = S^T W y.
    stws = [[0.0] * leaf_count for _ in range(leaf_count)]
    stwy = [0.0] * leaf_count
    for node_index, row in enumerate(s_matrix):
        weight = weights[node_index]
        for i in range(leaf_count):
            s_i = row[i]
            if s_i == 0.0:
                continue
            weighted = weight * s_i
            stwy[i] += weighted * y[node_index]
            for j in range(leaf_count):
                s_j = row[j]
                if s_j != 0.0:
                    stws[i][j] += weighted * s_j

    reconciled_leaves = _solve(stws, stwy)
    leaf_values = dict(zip(hierarchy.leaves, reconciled_leaves))
    if non_negative:
        leaf_values = {leaf: max(0.0, value) for leaf, value in leaf_values.items()}
        return reconcile_bottom_up(hierarchy, leaf_values)

    result = dict(leaf_values)
    for aggregate in hierarchy.aggregates:
        result[aggregate] = sum(leaf_values[leaf] for leaf in hierarchy.members[aggregate])
    return result
