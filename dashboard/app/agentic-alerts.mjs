// Numerical evidence stays outside the LLM; all quantities use material base units.
const quantity = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export function districtRisk(row, policy, now = new Date()) {
  const stock = quantity(row.current_stock_qty);
  const demand = quantity(row.cmp_monthly);
  const trigger = quantity(policy.months_trigger);
  const target = quantity(policy.min_months);
  if (trigger === null || trigger === 0 || target === null || target < trigger) throw Error('invalid_replenishment_policy');
  const freshnessHours = quantity(policy.stock_max_age_hours);
  if (freshnessHours === null || freshnessHours === 0 || !Number.isFinite(now.getTime())) throw Error('invalid_freshness_policy');
  const snapshot = Date.parse(row.snapshot_at);
  const stale = !Number.isFinite(snapshot) || snapshot > now.getTime() ||
    now.getTime() - snapshot > freshnessHours * 3_600_000;
  const evidence = {
    material_id: row.material_id, district_id: row.district_id,
    snapshot_at: row.snapshot_at, usage_as_of_date: row.usage_as_of_date,
    stock_qty: stock, cmp_monthly: demand,
  };
  if (row.source_stock_missing !== false || row.fixture_backed !== false ||
      row.input_data_class !== 'actual' || !row.usage_as_of_date || stock === null || demand === null || stale) {
    return { kind: 'data_quality', evidence, months_available: null,
      stale, action: 'ตรวจสอบข้อมูลสต็อกและอัตราใช้ก่อนยืนยันปริมาณเติม' };
  }
  if (demand === 0) return { kind: 'check_usage', evidence, months_available: null,
    action: 'ตรวจสอบความต้องการและหลักฐานอัตราใช้ศูนย์ก่อนกำหนดแผนเติม' };
  const coverage = stock / demand;
  return { kind: coverage < trigger ? 'replenishment' : 'covered', evidence,
    months_available: coverage,
    target_gap_qty: Math.max(0, Math.ceil(target * demand - stock)),
    action: coverage < trigger ? 'ตรวจแผนเติมและของระหว่างทางก่อนยืนยันการส่ง' : null };
}

export function warehouseSupply({ material_id, location_id, units, required_qty, inventory_complete = false }) {
  const required = quantity(required_qty);
  if (required === null) throw Error('invalid_required_quantity');
  let allocatable = 0;
  let incomplete = inventory_complete !== true;
  const seen = new Set();
  for (const unit of units) {
    if (unit.material_id !== material_id || unit.location_id !== location_id) continue;
    if (!unit.handling_unit_id || seen.has(unit.handling_unit_id)) throw Error('invalid_handling_unit_evidence');
    seen.add(unit.handling_unit_id);
    // Eligibility is supplied by the governed FIFO query, never inferred by the model.
    if (unit.eligible !== true) continue;
    const available = quantity(unit.available_qty);
    const reserved = quantity(unit.reserved_qty);
    if (available === null || reserved === null || reserved > available) { incomplete = true; continue; }
    allocatable += available - reserved;
  }
  return { material_id, location_id, required_qty: required, allocatable_qty: allocatable,
    shortfall_qty: incomplete ? null : Math.max(0, required - allocatable),
    incomplete, basis: 'eligible_handling_units_against_requested_quantity' };
}
