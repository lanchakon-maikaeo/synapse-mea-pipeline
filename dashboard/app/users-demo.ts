import type { UsersPayload } from "./user-management";

// Demo-mode sample for the user management page (no backend).
let cached: UsersPayload | null = null;

export function demoUsersPayload(): UsersPayload {
  cached ??= {
    me: "demo-admin",
    users: [
      { user_id: "demo-admin", email: "admin@mea.co.th", display_name: "ณัฐกานต์ (ส่วนกลาง)", role: "admin",
        district_id: null, district_name: null, is_active: true, last_sign_in_at: "2026-10-29T07:10:00Z", created_at: "2026-07-01T02:00:00Z" },
      { user_id: "demo-planner", email: "planner1@mea.co.th", display_name: "สมศักดิ์ วางแผน", role: "planner",
        district_id: null, district_name: null, is_active: true, last_sign_in_at: "2026-10-28T02:40:00Z", created_at: "2026-08-01T02:00:00Z" },
      { user_id: "demo-academic", email: "academic@mea.co.th", display_name: "ดร.วิภา วิชาการ", role: "academic",
        district_id: null, district_name: null, is_active: true, last_sign_in_at: "2026-10-20T03:00:00Z", created_at: "2026-08-01T02:00:00Z" },
      { user_id: "demo-picker", email: "store1@mea.co.th", display_name: "สมชาย คลัง", role: "picker",
        district_id: null, district_name: null, is_active: true, last_sign_in_at: null, created_at: "2026-10-25T02:00:00Z" },
      { user_id: "demo-district", email: "d5501@mea.co.th", display_name: "เขตนวลจันทร์", role: "district",
        district_id: "5501", district_name: "นวลจันทร์", is_active: true, last_sign_in_at: "2026-10-27T04:00:00Z", created_at: "2026-08-10T02:00:00Z" },
      { user_id: "demo-old", email: "old.staff@mea.co.th", display_name: "อดีตเจ้าหน้าที่", role: "viewer",
        district_id: null, district_name: null, is_active: false, last_sign_in_at: "2026-08-02T04:00:00Z", created_at: "2026-07-10T02:00:00Z" },
    ],
    requests: [
      { request_id: "r1", request_number: "AR-20261029-1A2B3C4D", full_name: "สมหญิง ใจดี", employee_id: "530123",
        work_email: "somying.j@mea.co.th", organization_unit: "การไฟฟ้าเขตสามเสน", requested_role: "district",
        reason: "ต้องยืนยันรายการพัสดุที่คลังส่งให้เขตทุกสัปดาห์", status: "pending", submitted_at: "2026-10-29T03:15:00Z",
        reviewed_at: null, reviewed_by_name: null, review_note: null, approved_role: null, approved_district_id: null,
        applied_at: null, account_user_id: null, account_role: null, account_active: null },
      { request_id: "r2", request_number: "AR-20261028-9F8E7D6C", full_name: "ประเสริฐ รับของ", employee_id: "540777",
        work_email: "store1@mea.co.th", organization_unit: "กองคลังพัสดุ", requested_role: "picker",
        reason: "รับพัสดุเข้าคลัง กรอก Packing และจ่ายตาม FIFO", status: "pending", submitted_at: "2026-10-28T08:00:00Z",
        reviewed_at: null, reviewed_by_name: null, review_note: null, approved_role: null, approved_district_id: null,
        applied_at: null, account_user_id: "demo-picker", account_role: "viewer", account_active: true },
      { request_id: "r3", request_number: "AR-20261020-11223344", full_name: "ผู้ขอภายนอก", employee_id: "X001",
        work_email: "someone@example.com", organization_unit: "บริษัทภายนอก", requested_role: "viewer",
        reason: "ขอดูข้อมูลสต็อกของการไฟฟ้า", status: "rejected", submitted_at: "2026-10-20T08:00:00Z",
        reviewed_at: "2026-10-20T09:00:00Z", reviewed_by_name: "ณัฐกานต์ (ส่วนกลาง)", review_note: "ไม่ใช่บุคลากร กฟน.",
        approved_role: null, approved_district_id: null, applied_at: null, account_user_id: null, account_role: null, account_active: null },
    ],
    history: [
      { audit_id: 3, occurred_at: "2026-10-27T03:00:00Z", operation: "UPDATE", actor: "ณัฐกานต์ (ส่วนกลาง)",
        target_user_id: "demo-old", target: "อดีตเจ้าหน้าที่", changes: { is_active: [true, false] } },
      { audit_id: 2, occurred_at: "2026-08-10T03:00:00Z", operation: "UPDATE", actor: "ณัฐกานต์ (ส่วนกลาง)",
        target_user_id: "demo-district", target: "เขตนวลจันทร์", changes: { role: ["viewer", "district"], district_id: [null, "5501"] } },
      { audit_id: 1, occurred_at: "2026-08-10T02:00:00Z", operation: "INSERT", actor: "ระบบ",
        target_user_id: "demo-district", target: "เขตนวลจันทร์",
        changes: { role: [null, "viewer"], district_id: [null, null], is_active: [null, true], display_name: [null, null] } },
    ],
  };
  return cached;
}
