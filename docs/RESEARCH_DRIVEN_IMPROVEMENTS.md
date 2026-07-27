# Research-driven improvements for SYNAPSE

จัดทำ: 2026-07-27

เอกสารนี้รวบรวมไอเดียจากงานวิจัยและโปรเจกต์โอเพนซอร์สในสาขาที่เกี่ยวข้อง
(spare-parts forecasting, inventory theory, multi-echelon optimization,
vehicle routing, data quality) แล้ว map เข้ากับโมดูลของ SYNAPSE พร้อมระบุ
สถานะ **implemented (candidate)** / **designed (roadmap)** อย่างชัดเจน

> **หลักการคงเดิม:** ทุกอย่างที่เพิ่มเข้ามาต้อง auditable, reproducible และ
> fail-closed จนกว่าจะผ่าน production release gate เหมือน pipeline ปัจจุบัน
> โค้ดใหม่อยู่ใน intelligence candidate layer และไม่แตะ frozen Business Rules v1
> จนกว่าจะ activate ผ่านขั้นตอนที่ระบุไว้

## สรุปสถานะ

| # | ไอเดีย | สาขา/ที่มา | โมดูล | สถานะ |
|---|---|---|---|---|
| 1 | Intermittent demand forecasting (Croston/SBA/TSB/ADIDA + ADI×CV² classification + MASE) | Spare-parts forecasting | M07 | **Implemented (candidate, gated)** |
| 2 | Statistical safety stock + (R,s,S)/order-up-to policy + inventory-aware simulation | Inventory theory / VMI | M06 | **Implemented (candidate)** |
| 3 | Hierarchical forecast reconciliation (coherent material→district→total) | Hierarchical forecasting | M07 | **Implemented (candidate)** |
| 4 | Multi-echelon inventory optimization (warehouse + district) | MEIO / guaranteed-service | M06/M08 | **Implemented (candidate)** |
| 5 | Second CVRP solver + solver-agnostic route benchmark | Vehicle routing | M08 | **Implemented (candidate)** (Clarke-Wright + comparator; PyVRP optional) |
| 6 | Declarative data-quality contracts (Great Expectations/Soda/dbt style) | Data engineering | M03/M04 | **Implemented (candidate)** |
| 7 | Obsolescence / slow-mover risk scoring | Intermittent + inventory | M06/M07 | **Implemented (candidate)** |

---

## 1. Intermittent demand forecasting — **implemented (candidate, gated)**

### ปัญหา

วัสดุไฟฟ้าของ กฟน. ส่วนมากเป็น demand แบบกระจุก (มีเดือนเป็นศูนย์จำนวนมาก)
สังเกตได้จาก Business Rules v1 เอง — `-` ใน 
usage แปลงเป็น `0`, ถ้า `CMP=0` ไม่คำนวณ, และต้องรอ history ≥14 เดือน แต่โมเดล
เดิม (Seasonal Naive / Moving Average / AutoETS) ออกแบบมาสำหรับ series ต่อเนื่อง
จึง bias และให้ prediction interval ที่ผิดพลาดบน series ที่เป็นศูนย์มาก

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/forecasting.py`:

- **`classify_demand()`** — จำแนก series เป็น `smooth / erratic / intermittent /
  lumpy` ด้วย ADI (average inter-demand interval) และ CV² ตาม cutoff
  Syntetos-Boylan-Croston (ADI=1.32, CV²=0.49)
- **Croston / SBA / TSB / ADIDA** — estimator สำหรับ intermittent demand
  (`croston_rate`, `croston_sba_rate`, `tsb_rate`, `adida_rate` และ list wrappers)
  โดย **TSB** อัปเดต demand probability ทุก period จึง decay เข้าใกล้ศูนย์เมื่อ
  ของเริ่มตาย (obsolescence) — คุณสมบัติที่ Croston ไม่มี
- **MASE** (`mean_absolute_scaled_error`) — metric scale-free ที่เหมาะกับ
  intermittent series (WAPE ถูกครอบงำด้วยเดือนศูนย์); `rolling_backtest` คำนวณ
  MASE ให้ทุกโมเดล
- **`forecast_intermittent()`** — backtest แล้วเลือกโมเดลด้วย MASE โดยยังเก็บ
  baseline ไว้ใน pool เสมอ (series ที่ถูกจำแนกผิดจะไม่ถูกบังคับให้ใช้ Croston)

### การทำงานร่วมกับของเดิม (gating)

`forecast_best_available(history, horizon, *, allow_intermittent=False)` —
ค่า default `False` ทำงาน **เหมือนเดิมทุกประการ** (baseline + AutoETS) เพื่อไม่ให้
contract ของ worker ที่ deploy อยู่เปลี่ยน เมื่อ `allow_intermittent=True` และ
series เป็น intermittent/lumpy จึงดึง Croston/SBA/TSB เข้ามาแข่งและเลือกด้วย MASE

Worker (`worker.py`) เปิดใช้งานผ่าน env `SYNAPSE_INTERMITTENT_FORECAST=1` และ
map model → `analytics.forecast_model_versions` ผ่าน `MODEL_VERSIONS`

### Activation (2 อย่างต้องไปด้วยกัน)

1. Apply `supabase/candidate/202607270001_m07b_intermittent_forecasting.sql`
   (ลงทะเบียน `croston-v1`, `croston-sba-v1`, `tsb-v1`, `adida-v1`) —
   ต้องมีก่อน ไม่งั้นละเมิด `model_version` foreign key
2. ตั้ง `SYNAPSE_INTERMITTENT_FORECAST=1` ให้ forecast worker

ดูขั้นตอนเต็มที่ `supabase/candidate/README.md`

### Tests

`intelligence/tests/test_forecasting.py` — classification 4 quadrant,
Croston rate, TSB obsolescence decay, intermittent selection + interval,
gate on/off, registry mapping

### References

- [A Review of Croston's method for intermittent demand forecasting](https://www.researchgate.net/publication/254044245_A_Review_of_Croston's_method_for_intermittent_demand_forecasting)
- [Intermittent demand, inventory obsolescence, and temporal aggregation forecasts (TSB, ADIDA)](https://www.tandfonline.com/doi/full/10.1080/00207543.2023.2199435)
- [A comparative study on spare part demand forecasting methods (EUR thesis)](https://thesis.eur.nl/pub/66680/-304)

---

## 2. Statistical safety stock + (R,s,S) policy — **implemented (candidate)**

### ปัญหา

Business Rules v1 ตั้ง `MIN = CMP×4`, `MAX = CMP×6` (จำนวนเดือนคงที่) —
ไม่สนความผันผวนของ demand หรือ lead time เขตที่ demand นิ่งกับเขตที่แกว่งได้ buffer
เท่ากันหมด

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/replenishment.py` (โมดูลใหม่, ไม่แตะ DB):

- **`safety_stock(std, service_level, protection)`** = `z(service level) ×
  σ√protection` โดย `normal_ppf` (Acklam) ให้ z โดยไม่ต้องพึ่ง SciPy
- **`periodic_policy(...)`** — สร้าง `(R,s,S)`: order-up-to `S` คุ้มช่วง
  review+lead, reorder point `s` คุ้ม lead time พร้อม safety stock ตามระดับบริการ
- **`demand_stats()`** — mean/std ต่อ period (เก็บศูนย์ไว้ เพราะความผันผวนของ
  series ทั้งชุดคือสิ่งที่ safety stock ต้องคุ้ม)
- **`simulate_periodic_review()`** — inventory-aware backtest: replay demand จริง
  ภายใต้ policy แล้ววัด fill rate (β), cycle service level (α) และ average on-hand
  → ให้ score forecast ด้วย "ผลต่อบริการจริง" ไม่ใช่แค่ค่า error และเป็น building
  block สำหรับ MEIO (ข้อ 4)

การผูกกับ M07: `periodic_policy` รับ mean/std ต่อ period ที่มาจาก forecast ของ M07
โดยตรง (forecast มี 80% interval อยู่แล้ว) → target ไม่ใช่เลขเดา แต่มาจากระดับบริการ

### Tests

`intelligence/tests/test_replenishment.py` — normal_ppf (z=0/1.6449/2.3263),
safety-stock monotonicity + √protection scaling, service-level monotonicity,
simulation fill rate สำหรับ policy ที่ size ถูก/ผิด

### แนวทาง activate

เป็น candidate analytics ที่ยังไม่ผูกกับ frozen rule; การนำไปใช้จริงควรทำเป็น
**advisory column คู่ขนาน** (แสดง "recommended MIN/MAX ตามระดับบริการ" ข้าง CMP×4/×6)
ให้ planner เทียบก่อน แล้วจึงเสนอแก้ Business Rules ผ่าน owner review — ไม่ override
เงียบ ๆ

### References

- Silver, Pyke & Thomas, *Inventory and Production Management in Supply Chains*
- [Optimal operational service levels in VMI contracts](https://www.sciencedirect.com/science/article/abs/pii/S0167637722001043)
- [Inventory control policies — (R,s,S) periodic review](https://smartcorp.com/inventory-control/inventory-control-policies-software/)

---

## 3. Hierarchical forecast reconciliation — **implemented (candidate)**

### ปัญหา

material→district→total เป็นลำดับชั้นตามธรรมชาติ การ forecast แยกทีละคู่มัก
ไม่ coherent (ผลรวมเขต ≠ ยอดคลัง) → วางแผน replenishment ที่คลองเตยผิด

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/hierarchy.py` (pure-Python, ไม่พึ่ง
NumPy/SciPy, ไม่แตะ DB):

- **`build_hierarchy()` / `summing_matrix()`** — สร้างโครงสร้าง aggregate→leaves
  และ summing matrix
- **`reconcile_bottom_up()`** — coherent by construction
- **`reconcile_min_trace()`** — MinT projection (`ols` และ `wls_struct`) รวม base
  forecast ทุกระดับให้ coherent และมักลด error เทียบกับใช้ระดับใดระดับหนึ่ง
  พร้อม option `non_negative` (clamp leaves ที่ 0 แล้ว re-aggregate ให้ยัง coherent)
- Linear solver ภายในเป็น Gaussian elimination + partial pivoting (เหมาะกับ
  hierarchy ขนาด 18 เขต)

การผูก: ป้อน base forecast จาก M07 (ต่อ horizon) เข้า reconcile → district ที่ได้
รวมกันเท่ายอดคลังพอดี แล้วส่ง coherent interval ไปที่ safety stock (ข้อ 2) ต่อ

### Tests

`intelligence/tests/test_hierarchy.py` — โครงสร้าง/summing matrix, coherence ของ
ทั้งสอง method, OLS spread, error reduction เมื่อ leaf bias, non-negative + coherent

### References

- Wickramasuriya, Athanasopoulos & Hyndman, "Optimal forecast reconciliation
  through trace minimization" (JASA, 2019)
- [Nixtla `HierarchicalForecast`](https://github.com/Nixtla/hierarchicalforecast)
  (reference implementation / probabilistic reconciliation หากต้องการต่อยอด)

## 4. Multi-echelon inventory optimization (MEIO) — **implemented (candidate)**

### ปัญหา

สถาปัตยกรรมเป็น 2 ชั้นอยู่แล้ว (central warehouse → 18 เขต) การตั้ง safety stock
ทีละ node แยกกันจมเงินเกิน และมองไม่เห็นว่า district stockout อาจเกิดจาก
**คลังเติมของให้เขตไม่ทัน (upstream)** ไม่ใช่ policy ของเขตเอง

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/multi_echelon.py` (pure-Python, ต่อยอด
`replenishment.py` ข้อ 2):

- **`simulate_two_echelon()`** — replay demand ของทุกเขตภายใต้ order-up-to ทั้ง
  สองชั้น โดย **propagate การขาดของที่คลังลงไปยัง service ของเขต** (allocate
  proportional เมื่อคลังของไม่พอ) รายงาน per-district + system fill rate,
  warehouse fill rate และ average on-hand ทั้งสองชั้น
- **`size_two_echelon_policy()`** — guaranteed-service starting point: size เขตจาก
  demand ตัวเอง (`periodic_policy`) และ size คลังจาก **aggregate demand** ช่วง
  supplier lead — ได้ **risk pooling** (aggregate std < ผลรวม std ของเขต เมื่อ
  cross-district independence) จึงถือ buffer ที่คลังน้อยกว่าซ้อน buffer รายเขต

### Tests

`intelligence/tests/test_multi_echelon.py` — generous stock = fill 1.0,
**warehouse shortage ดึง district fill ลง** (พิสูจน์ echelon coupling), sizing
ถึง service target ใน simulation, risk pooling

### References

- Graves & Willems / [guaranteed-service extensions (EJOR 2023)](https://www.sciencedirect.com/science/article/abs/pii/S0377221723006173)
- [multi-echelon-inventory-optimization (SimPy reference)](https://github.com/anshul-musing/multi-echelon-inventory-optimization)

## 5. Second CVRP solver + solver-agnostic route benchmark — **implemented (candidate)**

### สิ่งที่เพิ่ม

- **Comparator** `route_benchmark.py` — solver-agnostic (structural typing):
  `summarize_solution` คิด total distance/duration, served/unserved, utilization
  และ **capacity feasibility flag**; `compare_solutions` ตัดสินด้วยกฎ lexicographic
  (feasible → unserved น้อย → distance สั้น → utilization สูง) พร้อม rationale →
  ได้ "route benchmark report" ที่เกณฑ์รับงาน M08 ต้องการ
- **Second solver** `savings_solver.py` — Clarke-Wright savings CVRP (capacity
  weight/volume/pallets + heterogeneous fleet assignment) ผลิต `OptimizationResult`
  รูปเดียวกับ OR-Tools → เป็น solver ที่สองสำหรับ benchmark **โดยไม่ต้องเพิ่ม
  dependency** (ไม่บังคับ time windows จึงเป็น distance-focused capacity benchmark
  ไม่ใช่ dispatch plan)

Tests: `test_route_benchmark.py` (totals/utilization, feasibility, tie-break) และ
`test_savings_solver.py` (served/merge, capacity split, unserved, feed comparator)

### ที่เหลือ (optional)

- เพิ่ม **PyVRP adapter** ([PyVRP](https://arxiv.org/pdf/2403.13795), HGS-based) ที่
  ผลิต `OptimizationResult` รูปเดิม → เสียบเข้า comparator ได้ทันที (ต้องเพิ่ม
  dependency `pyvrp` + แตะ routing worker → reviewed change แยก)
- เชื่อม forecast+routing เป็น periodic IRP เพื่อลด total cost (transport+holding)

## 6. Declarative data-quality contracts — **implemented (candidate)**

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/data_quality.py` — declarative expectation
suite แบบ dependency-free (ไม่ต้องลง Great Expectations/Soda) ที่ให้แนวคิดเดียวกัน:

- Expectations: `not_null`, `unique`, `in_set`, `between`, `non_negative`,
  `matches_regex`, `row_count_between`, `foreign_key`, `column_exists`
- `run_suite()` → `DataQualityReport` ที่ `to_dict()` เป็น JSON ได้ → เก็บเป็น
  **data-contract evidence** ที่อ่านได้ ตรงกับวัฒนธรรม evidence-heavy

Tests: `intelligence/tests/test_data_quality.py` — ทุก expectation + suite
aggregation/serialisation

### แนวทางต่อยอด

Suite เดียวกันนี้แปลงเป็น [Great Expectations / Soda Core / dbt tests](https://atlan.com/open-source-data-quality-tools/)
ได้เมื่อทีมพร้อม adopt (ได้ Data Docs HTML + connector) และ dbt เหมาะกับ layer
`raw→staging→core→analytics` ที่ออกแบบไว้แต่ทำมือใน SQL migration

## 7. Obsolescence / slow-mover risk scoring — **implemented (candidate)**

### สิ่งที่เพิ่ม

`intelligence/src/synapse_intelligence/obsolescence.py` — รวมสัญญาณจากข้อ 1 เข้ากับ
rule overstock ">6 / >9 เดือน" ที่มีอยู่ เป็น risk score โปร่งใส (heuristic ที่
อธิบายได้ ไม่ใช่ learned model):

- **TSB smoothed demand probability** (ผ่าน `tsb_components`) — decay เมื่อของหยุด
  เคลื่อน = สัญญาณ obsolescence หลัก
- **ADI×CV² category** — lumpy/intermittent เสี่ยงกว่า smooth
- **trailing zero-demand streak** — scale เทียบ critical threshold (9 เดือน)
- **months of cover** จาก on-hand — ใช้ threshold >6/>9 เดิม

Output: `ObsolescenceSignal(risk_score 0..1, risk_level none/watch/warning/critical,
demand_probability, category, zero_streak, months_of_cover, reasons)` โดย `reasons`
ระบุเหตุผลที่ flag ทุกข้อ → planner เห็นของตายก่อนจมเงิน (utility spare parts เจอ
บ่อยเมื่อเปลี่ยน spec / ปลดอุปกรณ์)

### Tests

`intelligence/tests/test_obsolescence.py` — steady mover = none, stopped item =
warning/critical, overstock ดัน score ขึ้น, monotonic ตาม streak, score bounded

### References

- Teunter, Syntetos & Babai — demand-probability decay for obsolescent items
- SYNAPSE Business Rules v1 overstock thresholds (>6 / >9 เดือน)

---

## สถานะปัจจุบัน

**ครบทั้ง 7 ข้อ implemented เป็น candidate + tests** — ทั้งหมดอยู่ใน intelligence
layer, pure-Python, ไม่พึ่ง NumPy/SciPy/ortools/framework ภายนอก, ไม่แตะ frozen
Business Rules v1 หรือ DB contract, รันด้วย `make intelligence-test`

โมดูลใหม่: `replenishment.py`, `hierarchy.py`, `obsolescence.py`,
`multi_echelon.py`, `route_benchmark.py`, `savings_solver.py`, `data_quality.py`
และส่วนขยายใน `forecasting.py`

### ขั้นตอน activate (ผ่าน release gate เดิม, ไม่ override frozen rules เงียบ ๆ)

1. **ข้อ 1** — apply prepared migration + set `SYNAPSE_INTERMITTENT_FORECAST=1`
   (ดู `supabase/candidate/README.md`)
2. **ข้อ 2, 3, 4, 7** — เสนอเป็น dashboard **advisory columns** (recommended
   MIN/MAX, coherent forecast, obsolescence risk, echelon service) ให้ planner
   เทียบก่อน owner review
3. **ข้อ 5** — เสียบ `savings_solver` (หรือ PyVRP adapter) เข้า benchmark ใน M08
4. **ข้อ 6** — ใช้ `data_quality` suite ใน ingestion และ/หรือแปลงเป็น GE/Soda/dbt

การนำ candidate ทั้งหมดขึ้น production ควรผ่าน release gate เดิม (owner review,
acceptance SQL, `make workspace-ci`)
