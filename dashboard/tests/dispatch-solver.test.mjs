import assert from "node:assert/strict";
import test from "node:test";

import { moveTrip, solveDispatch } from "../app/dispatch-solver.ts";

const WEEK = "2026-11-09";
// [id, name, zone, weekday, lat, lon, depot_km]
const DISTRICTS = [
  ["5501", "นวลจันทร์", "NE", 4, 13.81895, 100.6441, 26],
  ["5502", "สามเสน", "N", 3, 13.78054, 100.51764, 16.8],
  ["5503", "นนทบุรี", "N", 3, 13.87001, 100.51778, 28.7],
  ["5504", "ธนบุรี", "S", 4, 13.746714, 100.470228, 16.1],
  ["5505", "บางใหญ่", "W", 3, 13.848364, 100.436094, 32],
  ["5506", "ลาดกระบัง", "E", 2, 13.815641, 100.746123, 32.5],
  ["5507", "บางนา", "SE", 2, 13.67613, 100.59186, 8],
  ["5508", "วัดเลียบ", "IN", 2, 13.741944, 100.5, 7.6],
  ["5509", "คลองเตย", "IN", 2, 13.72156, 100.55539, 1],
  ["5510", "ราษฎร์บูรณะ", "S", 4, 13.679075, 100.513051, 10],
  ["5511", "ยานนาวา", "S", 4, 13.693056, 100.493333, 13],
  ["5512", "บางขุนเทียน", "S", 4, 13.65557, 100.42435, 23],
  ["5513", "บางบัวทอง", "W", 3, 13.945677, 100.37977, 49],
  ["5514", "บางกะปิ", "E", 2, 13.74407, 100.60137, 11],
  ["5515", "สมุทรปราการ", "SE", 2, 13.594317, 100.606817, 23],
  ["5516", "บางพลี", "SE", 2, 13.6416, 100.71325, 23.5],
  ["5517", "มีนบุรี", "E", 2, 13.811607, 100.708497, 35],
  ["5518", "บางเขน", "NE", 4, 13.87107, 100.59534, 27],
];

const settings = {
  start_time: "09:30:00", return_by: "15:00:00", unload_minutes: 40, avg_speed_kmh: 30, road_factor: 1.55,
  pickup_max_km: 17, pickup_min_pallets: 5, pickup_rotation_weeks: 4, max_stops_per_trip: 4,
  baht_per_km: 9.64, toll_per_trip: 89, warehouse_lat: 13.72, warehouse_lon: 100.55,
  delivery_weekdays: [1, 2, 3, 4, 5], default_pallet_kg: 1250,
};
const vehicles = [
  { vehicle_code: "707", label: "พด.707", pallet_capacity: 8, max_payload_kg: null },
  { vehicle_code: "708", label: "พด.708", pallet_capacity: 8, max_payload_kg: null },
];

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function demand(pallets, extra = {}) {
  return {
    week_start: WEEK,
    settings: { ...settings, ...(extra.settings ?? {}) },
    vehicles: extra.vehicles ?? vehicles,
    districts: DISTRICTS.map(([id, name, zone, wd, lat, lon, km]) => {
      const p = pallets[id] ?? 0;
      const o = extra.district?.[id] ?? {};
      return {
        district_id: id, district_name: name, zone, zone_weekday: wd, promise_date: addDays(WEEK, wd - 1),
        latitude: lat, longitude: lon, depot_km: km, has_vehicle: null, pickup_allowed: true, last_pickup_date: null,
        pallets: p, full_pallets: Math.max(0, p - 1), mixed_fraction: p ? 0.6 : 0, weight_kg: p * 1200,
        lines: p ? 3 : 0, extra_lines: 0, packing_missing_lines: 0, weight_estimated_lines: 0, urgent: false, ...o,
      };
    }),
  };
}

const allStops = (plan) => plan.trips.flatMap((t) => t.stops.map((s) => ({ ...s, mode: t.mode, trip: t })));

test("normal week: every district delivered on or before its zone day, no pick-up", () => {
  const plan = solveDispatch(demand({ "5506": 3, "5517": 2, "5514": 2, "5507": 2, "5509": 1, "5502": 3, "5504": 2, "5510": 1 }));
  assert.equal(plan.metrics.pickups, 0);
  assert.equal(plan.metrics.overflow_trips, 0);
  assert.equal(plan.metrics.stops_late, 0);
  for (const s of allStops(plan)) assert.ok(s.trip.trip_date <= s.promise_date, `${s.district_name} late`);
  for (const t of plan.trips) {
    assert.ok(t.pallets <= 8);
    assert.ok(t.minutes <= 330, `${t.id} ${t.minutes} min`);
    assert.ok(t.stops.length <= 4);
  }
  const perDay = new Map();
  for (const t of plan.trips) {
    const k = `${t.trip_date}|${t.vehicle_code}`;
    perDay.set(k, [...(perDay.get(k) ?? []), t]);
  }
  for (const [k, list] of perDay) {
    const total = list.reduce((a, t) => a + t.minutes, 0) + 30 * (list.length - 1);
    assert.ok(total <= 330, `${k} ${total} min`);
    const ordered = list.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
    for (let i = 1; i < ordered.length; i += 1) assert.ok(ordered[i].start_time >= ordered[i - 1].return_time, `${k} overlaps`);
  }
});

test("goods-first never needs more trips than the fixed zone calendar", () => {
  const weeks = [
    { "5506": 2, "5514": 1, "5507": 2, "5509": 1, "5508": 1, "5502": 2, "5503": 1, "5501": 1, "5518": 1, "5504": 1, "5510": 1 },
    { "5501": 3, "5502": 2, "5503": 2, "5504": 1, "5505": 2, "5507": 1, "5511": 1, "5512": 2, "5516": 1 },
    { "5509": 4, "5508": 2, "5514": 3, "5507": 2, "5515": 1, "5513": 2, "5505": 1 },
  ];
  for (const w of weeks) {
    const plan = solveDispatch(demand(w));
    const goods = plan.metrics.delivery_trips + plan.metrics.pickups + plan.metrics.overflow_trips;
    const zone = plan.zone_metrics.delivery_trips + plan.zone_metrics.overflow_trips;
    assert.ok(goods <= zone, `goods ${goods} > zone ${zone}`);
    assert.ok(plan.metrics.km <= plan.zone_metrics.km + 1e-6);
  }
  const merged = solveDispatch(demand(weeks[0]));
  assert.ok(merged.metrics.fill_rate > merged.zone_metrics.fill_rate);
});

test("a district above one truckload gets a full truck first", () => {
  const plan = solveDispatch(demand({ "5506": 11, "5517": 2 }));
  const lk = allStops(plan).filter((s) => s.district_id === "5506");
  assert.deepEqual(lk.map((s) => s.pallets).sort((a, b) => b - a), [8, 3]);
  assert.ok(plan.trips.some((t) => t.stops.length === 1 && t.pallets === 8));
});

test("payload limits pallets per truck", () => {
  const plan = solveDispatch(demand({ "5506": 8 }, {
    vehicles: vehicles.map((v) => ({ ...v, max_payload_kg: 6000 })),
  }));
  // 1,200 kg per pallet → 5 pallets per truck
  assert.ok(plan.trips.every((t) => t.weight_kg <= 6000));
  assert.deepEqual(plan.trips.map((t) => t.pallets).sort(), [3, 5]);
  assert.ok(!plan.warnings.some((w) => w.code === "payload_unknown"));
  assert.ok(solveDispatch(demand({ "5506": 1 })).warnings.some((w) => w.code === "payload_unknown"));
});

test("pick-up only in an overflow week, near single-district loads, rotation and urgency respected", () => {
  const heavy = Object.fromEntries(DISTRICTS.map(([id]) => [id, 7]));
  const plan = solveDispatch(demand(heavy, {
    district: {
      "5509": { last_pickup_date: "2026-10-26" },
      "5508": { urgent: true },
      "5502": { pickup_allowed: false },
    },
  }));
  const pickups = plan.trips.filter((t) => t.mode === "pickup");
  assert.ok(pickups.length >= 1);
  assert.ok(plan.trips.filter((t) => t.mode === "delivery").length >= 10);
  for (const t of pickups) {
    assert.equal(t.stops.length, 1);
    assert.ok(t.pallets >= 5);
    const id = t.stops[0].district_id;
    assert.ok(!["5508", "5502", "5506", "5513"].includes(id), `${id} should not pick up`);
    assert.match(t.reason, /ส่งไม่ทัน/);
  }
  // 5509 picked up 2 weeks ago → only used after the others
  const ids = pickups.map((t) => t.stops[0].district_id);
  if (ids.includes("5509")) assert.ok(ids.includes("5507") && ids.includes("5514") && ids.includes("5510"));
  assert.ok(plan.trips.filter((t) => t.mode === "delivery").every((t) => t.vehicle_code));
});

test("normal week never asks a near district to pick up", () => {
  const plan = solveDispatch(demand({ "5509": 8, "5507": 6 }));
  assert.equal(plan.metrics.pickups, 0);
});

test("no pick-up candidate leaves overflow with a reason", () => {
  const far = Object.fromEntries(DISTRICTS.map(([id]) => [id, 8]));
  const plan = solveDispatch(demand(far, { settings: { pickup_max_km: 0 } }));
  assert.equal(plan.metrics.pickups, 0);
  assert.ok(plan.metrics.overflow_trips >= 1);
  assert.equal(plan.metrics.pallets, 18 * 8);
  assert.ok(plan.warnings.some((w) => w.code === "overflow"));
});

test("layout: first stop sits at the tailgate", () => {
  const plan = solveDispatch(demand({ "5517": 3, "5506": 3 }));
  const trip = plan.trips.find((t) => t.stops.length === 2);
  assert.ok(trip);
  const first = trip.stops[0].district_id;
  const filled = trip.layout.filter((s) => s.district_id);
  assert.equal(filled.length, 6);
  assert.equal(filled[filled.length - 1].district_id, first);
  assert.equal(filled[0].district_id, trip.stops[1].district_id);
  assert.equal(trip.layout.length, 8);
});

test("moving a trip onto a used truck-day is flagged", () => {
  const plan = solveDispatch(demand({ "5506": 6, "5513": 6, "5512": 6 }));
  const [a, b] = plan.trips;
  assert.ok(!moveTrip(plan, a.id, a.trip_date, a.vehicle_code, "delivery").warnings.some((w) => w.code === "slot_conflict"));
  const moved = moveTrip(plan, b.id, a.trip_date, a.vehicle_code, "delivery");
  assert.ok(moved.warnings.some((w) => w.code === "slot_conflict"));
  const pickup = moveTrip(plan, b.id, WEEK, null, "pickup");
  assert.equal(pickup.metrics.pickups, 1);
});

test("a truck back early runs a second short trip the same day", () => {
  // Tuesday-heavy week: 5 near trips due Tuesday, only 4 truck-days by then
  const week = { "5509": 8, "5508": 8, "5507": 8, "5514": 8, "5506": 8 };
  const single = solveDispatch(demand(week));
  assert.ok(single.metrics.stops_late > 0);
  assert.ok(single.warnings.some((w) => w.code === "second_trip_hint"));
  const plan = solveDispatch(demand(week, { settings: { max_trips_per_truck_day: 2 } }));
  assert.equal(plan.metrics.pickups, 0);
  assert.equal(plan.metrics.stops_late, 0);
  const days = new Map();
  for (const t of plan.trips) days.set(`${t.trip_date}|${t.vehicle_code}`, (days.get(`${t.trip_date}|${t.vehicle_code}`) ?? 0) + 1);
  assert.ok([...days.values()].some((n) => n > 1));
});
