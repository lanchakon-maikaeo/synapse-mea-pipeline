import json
import unittest

from synapse_pipeline.legacy_actual import parse_cmp, parse_materials, parse_warehouse_stock


class LegacyActualSourceTests(unittest.TestCase):
    def test_material_normalization(self):
        payload = parse_materials(json.dumps([
            {"id": "471050004000", "name": "PVC CONDUIT", "unit": "อัน"}
        ]).encode())
        self.assertEqual(payload.source_key, "materials")
        self.assertEqual(payload.rows[0]["material_id"], "471050004000")
        self.assertEqual(payload.metadata["total_rows"], 1)

    def test_warehouse_stock_normalization(self):
        content = json.dumps({
            "date": "Fri Jul 03 2026 14:00:00 GMT+0700 (เวลาอินโดจีน)",
            "stock": {"471050004000": {"คลองเตย": {"qty": 120}}},
        }, ensure_ascii=False).encode()
        payload = parse_warehouse_stock(content)
        self.assertEqual(payload.rows[0]["quantity_on_hand"], 120)
        self.assertEqual(payload.rows[0]["snapshot_at"], "2026-07-03T14:00:00+07:00")

    def test_cmp_maps_real_sap_plant_and_months(self):
        csv_text = (
            "พัสดุ,โรงงาน,พัสดุ&โรงงาน,CMP,LY,12,6,4,,,2025,042026,032026,022026,012026,122025,112025,102025,092025,082025,072025,062025,052025\n"
            "471050004000,6701,x,21,20,19,18,17,,,248,8,9,10,11,12,13,14,15,16,17,18,19\n"
            "471050004000,2401,x,21,20,19,18,17,,,248,8,9,10,11,12,13,14,15,16,17,18,19\n"
        )
        payload = parse_cmp(csv_text.encode("utf-8"))
        self.assertEqual(len(payload.rows), 1)
        self.assertEqual(payload.rows[0]["district_id"], "5509")
        self.assertEqual(len(payload.rows[0]["history"]), 12)

    def test_cmp_preserves_negative_adjustment_outside_forecast_history(self):
        csv_text = (
            "พัสดุ,โรงงาน,พัสดุ&โรงงาน,CMP,LY,12,6,4,,,2025,042026,032026,022026,012026,122025,112025,102025,092025,082025,072025,062025,052025\n"
            "471050004000,6701,x,21,20,19,18,17,,,248,-4,9,10,11,12,13,14,15,16,17,18,19\n"
        )
        payload = parse_cmp(csv_text.encode("utf-8"))
        self.assertEqual(len(payload.rows[0]["history"]), 11)
        self.assertEqual(payload.rows[0]["negative_history"][0]["demand_quantity"], -4)
        self.assertEqual(
            payload.metadata["negative_demand_observations_preserved_in_raw_and_excluded_from_features"], 1
        )

    def test_cmp_preserves_negative_cmp_in_raw_and_normalizes_core_rate(self):
        csv_text = (
            "พัสดุ,โรงงาน,พัสดุ&โรงงาน,CMP,LY,12,6,4,,,2025,042026,032026,022026,012026,122025,112025,102025,092025,082025,072025,062025,052025\n"
            "471050004000,6701,x,-7,20,19,18,17,,,248,8,9,10,11,12,13,14,15,16,17,18,19\n"
        )
        payload = parse_cmp(csv_text.encode("utf-8"))
        self.assertEqual(payload.rows[0]["cmp_monthly"], 0)
        self.assertEqual(payload.rows[0]["negative_cmp_monthly_adjustment"], -7)


if __name__ == "__main__":
    unittest.main()
