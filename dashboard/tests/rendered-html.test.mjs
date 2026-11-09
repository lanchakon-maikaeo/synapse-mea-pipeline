import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("renders the MEA Synapse operational workspace in Thai", async () => {
  const html = await readFile(new URL(".next/server/app/index.html", root), "utf8");
  assert.match(html, /MEA Synapse/);
  assert.match(html, /งานคลังพัสดุ/);
  assert.match(html, /เข้าสู่ระบบ MEA Synapse/);
  assert.match(html, /ชื่อผู้ใช้หรืออีเมล/);
  assert.match(html, /รหัสผ่าน/);
  // English chrome and admin/technical jargon must be gone from the sign-in view.
  assert.doesNotMatch(
    html,
    /Sign in to MEA Synapse|Username or email|SUPABASE AUTH · RBAC|Administrator/,
  );
  assert.doesNotMatch(html, /Your site is taking shape|Codex is working/);
});

test("keeps the UI aligned with the frozen production operations scope", async () => {
  // page.tsx is split by job; the screens it renders are read together.
  const [pageParts, layout] = await Promise.all([
    Promise.all(
      ["page.tsx", "weekly-plan-view.tsx", "data-import-view.tsx", "view-helpers.tsx"].map((file) =>
        readFile(new URL(`app/${file}`, root), "utf8"),
      ),
    ),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);
  const page = pageParts.join("\n");
  // Localized (Thai) surface for the frozen operational scope.
  for (const required of [
    "แผนการจ่ายรายสัปดาห์",
    "ยืนยันรายการพัสดุ",
    "ผู้วางแผน",
    "นักวิชาการ",
    "เจ้าหน้าที่คลัง",
    "ผู้บริหาร / ผู้ดูข้อมูล",
    "ศูนย์ควบคุมการทำงาน",
    "หลักฐานการคำนวณปริมาณ",
    "ตรวจคำขอที่ผิดปกติ",
    "สอบกลับการจ่าย",
    "การจ่ายกรณีพิเศษ",
    // Frozen governance / wiring invariants (must stay in code).
    "OPENING_UNKNOWN",
    "scope_excluded",
    "useSynapseBackend",
    "backend.createReplenishmentRun",
    "backend.respondReplenishment",
    "เขตยืนยันเป็นรายรายการ",
  ]) assert.match(page, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(page, /Administrator/);
  assert.match(layout, /MEA Synapse — Warehouse Operations/);
  assert.doesNotMatch(page, /Queue Forecast Run|สร้าง Route job|SYNAPSE AI ASSISTANT/);
});
