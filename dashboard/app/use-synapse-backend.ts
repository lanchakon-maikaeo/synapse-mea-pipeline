"use client";

import type { PlannerSelectionPayload } from "./plan-submit";
import { createClient, type Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiRequest,
  isAuthConfigured,
  publicConfig,
  resolveSignInIdentifier,
  type Identity,
} from "./lib";
import type { VmiInputPayload } from "./pipeline-validation";
import {
  DEMO_MODE,
  demoData,
  demoIdentity,
  demoSession,
  demoVmiContext,
} from "./demo-data";
import type { Role } from "./lib";

export type { VmiDemandPoint, VmiInputPayload } from "./pipeline-validation";

export type RecordRow = Record<string, unknown>;

export type VmiContext = {
  material: RecordRow;
  district: RecordRow;
  stock: RecordRow | null;
  usage_rate: RecordRow | null;
  history: RecordRow[];
};

export type ReplenishmentResponsePayload = {
  decision: "confirm" | "reject" | "change";
  confirmed_qty: number;
  reason: string;
  requester_name: string;
};

export type ReceiptPayload = {
  contract_item_id: number;
  location_id: string;
  acceptance_date: string;
  quantity: number;
  handling_unit_code: string;
  unit_type:
    | "FULL_PALLET"
    | "BOX"
    | "CRATE"
    | "BUNDLE"
    | "LOOSE"
    | "LONG_MATERIAL";
  opening_status: "SEALED" | "OPENING_UNKNOWN";
  installment_no?: string;
  source_reference: string;
};

export type AdHocIssuePayload = {
  material_id: string;
  district_id: string;
  requested_qty: number;
  reason: string;
  requester_name: string;
  idempotency_key?: string;
  urgency_code?: string;
  urgency_note?: string;
};

export type DashboardData = {
  contracts: RecordRow[];
  quality: RecordRow[];
  stock: RecordRow[];
  warehouseStock: RecordRow[];
  replenishment: RecordRow[];
  recommendations: RecordRow[];
  changeRequests: RecordRow[];
  approvals: RecordRow[];
  fifo: RecordRow[];
  handlingUnits: RecordRow[];
  receiptOptions: RecordRow[];
  adHocIssues: RecordRow[];
  traceability: RecordRow[];
  operations: RecordRow | null;
  readiness: RecordRow | null;
  alerts: RecordRow[];
  materials: RecordRow[];
  districts: RecordRow[];
  inputSubmissions: RecordRow[];
  legacyStatus: RecordRow | null;
};

export const emptyData: DashboardData = {
  contracts: [],
  quality: [],
  stock: [],
  warehouseStock: [],
  replenishment: [],
  recommendations: [],
  changeRequests: [],
  approvals: [],
  fifo: [],
  handlingUnits: [],
  receiptOptions: [],
  adHocIssues: [],
  traceability: [],
  operations: null,
  readiness: null,
  alerts: [],
  materials: [],
  districts: [],
  inputSubmissions: [],
  legacyStatus: null,
};

const browserSupabase = !DEMO_MODE && isAuthConfigured()
  ? createClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey)
  : null;

export function useSynapseBackend() {
  const authConfigured = !DEMO_MODE && isAuthConfigured();
  const [session, setSession] = useState<Session | null>(DEMO_MODE ? demoSession : null);
  const [identity, setIdentity] = useState<Identity | null>(DEMO_MODE ? demoIdentity("planner") : null);
  const [data, setData] = useState<DashboardData>(DEMO_MODE ? demoData : emptyData);
  const [loading, setLoading] = useState(DEMO_MODE ? false : authConfigured);
  const [authBusy, setAuthBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState(
    DEMO_MODE || authConfigured ? "" : "ขณะนี้ยังเข้าสู่ระบบไม่ได้ กรุณาลองใหม่ภายหลังหรือแจ้งเจ้าหน้าที่",
  );
  const [notice, setNotice] = useState("");
  const sessionTokenRef = useRef<string | null>(null);
  const sessionLoadRef = useRef<{ token: string; promise: Promise<void> } | null>(null);
  const supabase = browserSupabase;

  const load = useCallback(async (activeSession: Session) => {
    setLoading(true);
    setError("");
    let identityResolved = false;
    try {
      const token = activeSession.access_token;
      const me = await apiRequest<Identity>("/v1/me", token);
      const metadata = activeSession.user.user_metadata;
      let displayName = String(
        metadata?.display_name ??
          metadata?.full_name ??
          metadata?.name ??
          activeSession.user.email ??
          "",
      ).trim();
      if (browserSupabase) {
        const { data: profile } = await browserSupabase
          .from("user_profiles")
          .select("display_name")
          .eq("user_id", me.user_id)
          .maybeSingle();
        if (typeof profile?.display_name === "string" && profile.display_name.trim()) {
          displayName = profile.display_name.trim();
        }
      }
      setIdentity({ ...me, display_name: displayName || me.user_id });
      identityResolved = true;

      const contractReader = ["admin", "planner", "viewer"].includes(me.role);
      const operationsReader = ["admin", "planner", "viewer"].includes(me.role);
      const warehouseReader = me.role !== "district";
      const receiver = me.role === "admin" || me.role === "picker";
      const alertReader = me.role === "admin" || me.role === "planner";
      const failures: string[] = [];
      const read = async <T,>(
        label: string,
        request: Promise<T>,
        fallback: T,
      ): Promise<T> => {
        try {
          return await request;
        } catch (requestError) {
          const message =
            requestError instanceof Error
              ? requestError.message
              : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";
          failures.push(`${label}: ${message}`);
          return fallback;
        }
      };

      const [
        contracts,
        quality,
        stock,
        replenishment,
        recommendations,
        changeRequests,
        approvals,
        fifo,
        handlingUnits,
        receiptOptions,
        adHocIssues,
        traceability,
        operations,
        readiness,
        alerts,
        materials,
        districts,
        inputSubmissions,
        warehouseStock,
        legacyStatus,
      ] = await Promise.all([
        read(
          "contracts",
          contractReader
            ? apiRequest<RecordRow[]>("/v1/contracts?limit=100", token)
            : Promise.resolve([]),
          [],
        ),
        read(
          "data quality",
          contractReader
            ? apiRequest<RecordRow[]>("/v1/data-quality?limit=100", token)
            : Promise.resolve([]),
          [],
        ),
        read(
          "stock health",
          apiRequest<RecordRow[]>("/v1/stock-health?limit=250", token),
          [],
        ),
        read(
          "replenishment queue",
          apiRequest<RecordRow[]>("/v1/replenishment/queue", token),
          [],
        ),
        read(
          "recommendations",
          apiRequest<RecordRow[]>("/v1/replenishment/recommendations", token),
          [],
        ),
        read(
          "change requests",
          apiRequest<RecordRow[]>("/v1/replenishment/change-requests", token),
          [],
        ),
        read(
          "approvals",
          apiRequest<RecordRow[]>("/v1/replenishment/approvals", token),
          [],
        ),
        read(
          "FIFO",
          warehouseReader
            ? apiRequest<RecordRow[]>("/v1/inventory/fifo", token)
            : Promise.resolve([]),
          [],
        ),
        read(
          "handling units",
          warehouseReader
            ? apiRequest<RecordRow[]>("/v1/inventory/handling-units", token)
            : Promise.resolve([]),
          [],
        ),
        read(
          "receipt options",
          receiver
            ? apiRequest<RecordRow[]>(
                "/v1/inventory/receipt-options?limit=500",
                token,
              )
            : Promise.resolve([]),
          [],
        ),
        read(
          "ad-hoc issues",
          apiRequest<RecordRow[]>("/v1/ad-hoc/issues", token),
          [],
        ),
        read(
          "traceability",
          apiRequest<RecordRow[]>("/v1/traceability", token),
          [],
        ),
        read(
          "operations health",
          operationsReader
            ? apiRequest<RecordRow>("/v1/operations/health", token)
            : Promise.resolve(null),
          null,
        ),
        read(
          "production readiness",
          apiRequest<RecordRow>("/v1/operations/readiness", token),
          null,
        ),
        read(
          "operations alerts",
          alertReader
            ? apiRequest<RecordRow[]>("/v1/operations/alerts", token)
            : Promise.resolve([]),
          [],
        ),
        read(
          "materials",
          apiRequest<RecordRow[]>("/v1/reference/materials?limit=2000", token),
          [],
        ),
        read(
          "districts",
          apiRequest<RecordRow[]>("/v1/reference/districts", token),
          [],
        ),
        read(
          "governed inputs",
          apiRequest<RecordRow[]>("/v1/data-inputs/vmi?limit=20", token),
          [],
        ),
        read(
          "warehouse stock",
          apiRequest<RecordRow[]>("/v1/warehouse-stock?limit=1000", token),
          [],
        ),
        read(
          "legacy source status",
          apiRequest<RecordRow>("/v1/data-sources/legacy/status", token),
          null,
        ),
      ]);

      setData({
        contracts,
        quality,
        stock,
        replenishment,
        recommendations,
        changeRequests,
        approvals,
        fifo,
        handlingUnits,
        receiptOptions,
        adHocIssues,
        traceability,
        operations,
        readiness,
        alerts,
        materials,
        districts,
        inputSubmissions,
        warehouseStock,
        legacyStatus,
      });
      if (failures.length) {
        setError(
          `โหลดสำเร็จบางส่วน (${20 - failures.length}/20): ${failures.join(
            " | ",
          )}`,
        );
      }
    } catch (loadError) {
      if (!identityResolved) setIdentity(null);
      setError(
        loadError instanceof Error ? loadError.message : "ไม่สามารถโหลดข้อมูลได้",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const ensureSessionLoaded = useCallback((activeSession: Session) => {
    const token = activeSession.access_token;
    sessionTokenRef.current = token;
    setSession(activeSession);
    const pending = sessionLoadRef.current;
    if (pending?.token === token) return pending.promise;

    const promise = load(activeSession);
    sessionLoadRef.current = { token, promise };
    void promise.finally(() => {
      if (sessionLoadRef.current?.promise === promise) {
        sessionLoadRef.current = null;
      }
    });
    return promise;
  }, [load]);

  useEffect(() => {
    if (DEMO_MODE) return;
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession()
      .then(({ data: authData }) => {
        if (!active) return;
        if (authData.session) void ensureSessionLoaded(authData.session);
        else setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : "ไม่สามารถตรวจสอบ Session ได้");
      });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        if (!active) return;
        if (!nextSession) {
          sessionTokenRef.current = null;
          sessionLoadRef.current = null;
          setSession(null);
          setIdentity(null);
          setData(emptyData);
          setLoading(false);
          return;
        }
        const tokenChanged = nextSession.access_token !== sessionTokenRef.current;
        if (tokenChanged || sessionLoadRef.current?.token === nextSession.access_token) {
          void ensureSessionLoaded(nextSession);
        }
      },
    );
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [ensureSessionLoaded, supabase]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      if (DEMO_MODE) {
        const requestedRole = ["admin", "planner", "academic", "picker", "viewer", "district"].find((role) => identifier.toLowerCase().includes(role)) as Role | undefined;
        setSession(demoSession);
        setIdentity(demoIdentity(requestedRole ?? "planner"));
        setData(demoData);
        return true;
      }
      if (!supabase) {
        setError("ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase");
        return false;
      }
      setAuthBusy(true);
      setError("");
      try {
        const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({
          email: resolveSignInIdentifier(identifier),
          password,
        });
        if (signInError || !authData.session) {
          setError(signInError?.message ?? "ไม่สามารถเข้าสู่ระบบได้");
          return false;
        }
        await ensureSessionLoaded(authData.session);
        return true;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "ไม่สามารถเชื่อมต่อระบบเข้าสู่ระบบได้");
        return false;
      } finally {
        setAuthBusy(false);
      }
    },
    [ensureSessionLoaded, supabase],
  );

  const signOut = useCallback(async () => {
    if (DEMO_MODE) {
      setNotice("Local Demo Mode: ใช้ตัวสลับบทบาทด้านบนแทนการออกจากระบบ");
      return;
    }
    if (supabase) await supabase.auth.signOut();
    sessionTokenRef.current = null;
    sessionLoadRef.current = null;
    setSession(null);
    setIdentity(null);
    setData(emptyData);
    setError("");
    setNotice("");
  }, [supabase]);

  const refresh = useCallback(async () => {
    if (DEMO_MODE) {
      setData(demoData);
      setNotice("รีเซ็ตข้อมูลตัวอย่างแล้ว");
      window.setTimeout(() => setNotice(""), 3000);
      return;
    }
    if (session) await load(session);
  }, [load, session]);

  const runAction = useCallback(
    async <T,>(
      path: string,
      body: unknown,
      successMessage: string,
    ): Promise<T | null> => {
      if (DEMO_MODE) {
        setActionBusy(true);
        setError("");
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        setNotice(`${successMessage} (Demo เท่านั้น — ไม่บันทึกฐานข้อมูล)`);
        window.setTimeout(() => setNotice(""), 4200);
        setActionBusy(false);
        return { demo: true } as T;
      }
      if (!session) return null;
      const operationalMutation =
        path.startsWith("/v1/replenishment/") ||
        path.startsWith("/v1/inventory/") ||
        path.startsWith("/v1/ad-hoc/");
      if (
        operationalMutation &&
        data.readiness?.operational_writes_enabled !== true
      ) {
        setError(
          "ขณะนี้ยังไม่เปิดให้บันทึกข้อมูลจริง เปิดให้อ่านและตรวจข้อมูลได้เท่านั้น",
        );
        return null;
      }
      setActionBusy(true);
      setError("");
      try {
        const result = await apiRequest<T>(path, session.access_token, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setNotice(successMessage);
        window.setTimeout(() => setNotice(""), 4200);
        await load(session);
        return result;
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "ไม่สามารถดำเนินการได้ กรุณาลองใหม่",
        );
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    [data.readiness, load, session],
  );

  const loadVmiContext = useCallback(
    async (materialId: string, districtId: string) => {
      if (DEMO_MODE) return demoVmiContext(materialId, districtId);
      if (!session) return null;
      setError("");
      try {
        const query = new URLSearchParams({
          material_id: materialId,
          district_id: districtId,
        });
        return await apiRequest<VmiContext>(
          `/v1/data-inputs/vmi/context?${query.toString()}`,
          session.access_token,
        );
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "ไม่สามารถโหลด VMI context ได้",
        );
        return null;
      }
    },
    [session],
  );

  const createReplenishmentRun = useCallback(
    async () =>
      (await runAction(
        "/v1/replenishment/runs",
        {},
        "สร้าง Weekly Plan จากข้อมูลที่ผ่านกติกาแล้ว",
      )) !== null,
    [runAction],
  );

  const submitPlannerSelection = useCallback(
    async (planId: string, payload: PlannerSelectionPayload) => {
      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => {
          const template = current.replenishment.find(
            (row) => String(row.replenishment_plan_id) === planId,
          );
          const keep = new Map(
            payload.lines
              .filter((line) => line.replenishment_item_id)
              .map((line) => [String(line.replenishment_item_id), line]),
          );
          const dropped = new Map(
            payload.dropped.map((line) => [line.replenishment_item_id, line]),
          );
          const updated = current.replenishment.map((row) => {
            const id = String(row.replenishment_item_id);
            if (String(row.replenishment_plan_id) !== planId) return row;
            const line = keep.get(id);
            if (line) {
              return {
                ...row,
                planner_qty: line.quantity,
                requested_qty: line.quantity,
                final_qty: line.quantity,
                planner_source: "system",
                item_status: "pending",
                planner_selected_at: actedAt,
              };
            }
            const drop = dropped.get(id);
            if (drop) {
              return {
                ...row,
                item_status: "cancelled",
                district_note: `Planner ไม่ส่ง: ${drop.reason}`,
              };
            }
            return row;
          });
          const added = payload.lines
            .filter((line) => !line.replenishment_item_id)
            .map((line, index) => ({
              ...(template ?? {}),
              replenishment_item_id: `RI-DEMO-ADD-${Date.now()}-${index}`,
              replenishment_plan_id: planId,
              district_id: line.district_id,
              district_name_th: line.district_name_th,
              material_id: line.material_id,
              material_name: line.material_name,
              suggested_qty: 0,
              planner_qty: line.quantity,
              confirmed_qty: null,
              requested_qty: line.quantity,
              final_qty: line.quantity,
              planner_source: "added",
              planner_note: line.reason,
              item_status: "pending",
              requester_name: null,
              district_note: null,
              planner_selected_at: actedAt,
            }));
          return {
            ...current,
            replenishment: [...updated, ...added].map((row) =>
              String(row.replenishment_plan_id) === planId
                ? { ...row, plan_status: "pending_district_confirmation" }
                : row,
            ),
          };
        });
      }
      return (
        (await runAction(
          `/v1/replenishment/plans/${encodeURIComponent(planId)}/planner-selection`,
          payload,
          `ส่งแผน ${payload.lines.length} รายการให้เขตยืนยันแล้ว`,
        )) !== null
      );
    },
    [runAction],
  );

  const publishVmiInput = useCallback(
    async (payload: VmiInputPayload) =>
      (await runAction(
        "/v1/data-inputs/vmi",
        payload,
        "เผยแพร่ข้อมูลผ่าน Raw → Staging → Core/Analytics แล้ว",
      )) !== null,
    [runAction],
  );

  const publishPackagingProfiles = useCallback(
    async (profiles: RecordRow[], sourceReference: string) =>
      (await runAction(
        "/v1/admin/packaging-profiles",
        { profiles, source_reference: sourceReference },
        "บันทึก Packaging Master พร้อมขนาด ความจุพาเลท และน้ำหนักลง Supabase แล้ว",
      )) !== null,
    [runAction],
  );

  const publishFifoOpening = useCallback(
    async (
      profiles: RecordRow[],
      handlingUnits: RecordRow[],
      sourceReference: string,
    ) =>
      (await runAction(
        "/v1/admin/fifo-opening",
        {
          profiles,
          handling_units: handlingUnits,
          source_reference: sourceReference,
        },
        "บันทึก Packaging Master, Opening HU และยอด Stock คลังคลองเตยลง Supabase แล้ว",
      )) !== null,
    [runAction],
  );

  const respondReplenishment = useCallback(
    async (itemId: string, payload: ReplenishmentResponsePayload) => {
      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => {
          const target = current.replenishment.find(
            (row) => String(row.replenishment_item_id) === itemId,
          );
          const planId = String(target?.replenishment_plan_id ?? "");
          const nextItems = current.replenishment.map((row) =>
            String(row.replenishment_item_id) === itemId
              ? {
                  ...row,
                  confirmed_qty: payload.confirmed_qty,
                  requested_qty: payload.confirmed_qty,
                  requester_name: payload.requester_name,
                  response_reason: payload.reason,
                  response_status:
                    payload.decision === "change"
                      ? "change_requested"
                      : payload.decision === "reject"
                        ? "rejected"
                        : "confirmed",
                  item_status:
                    payload.decision === "change"
                      ? "change_requested"
                      : payload.decision === "reject"
                        ? "rejected"
                        : "confirmed",
                  district_responded_at: actedAt,
                }
              : row,
          );
          const planItems = nextItems.filter(
            (row) => String(row.replenishment_plan_id) === planId,
          );
          const districtComplete = planItems.every((row) =>
            ["confirmed", "rejected"].includes(String(row.item_status)),
          );
          const replenishment = nextItems.map((row) =>
            String(row.replenishment_plan_id) === planId
              ? {
                  ...row,
                  plan_status: districtComplete
                    ? "pending_planner_approval"
                    : "district_review",
                }
              : row,
          );
          const existingRequest = current.changeRequests.find(
            (row) => String(row.replenishment_item_id) === itemId,
          );
          const changeRequests =
            payload.decision === "change"
              ? existingRequest
                ? current.changeRequests.map((row) =>
                    String(row.replenishment_item_id) === itemId
                      ? {
                          ...row,
                          requested_qty: payload.confirmed_qty,
                          reason: payload.reason,
                          requester_name: payload.requester_name,
                          status: "pending_review",
                          created_at: actedAt,
                        }
                      : row,
                  )
                : [
                    {
                      change_request_id: `CR-DEMO-${Date.now()}`,
                      replenishment_item_id: itemId,
                      replenishment_plan_id: planId,
                      plan_code: target?.plan_code,
                      district_id: target?.district_id,
                      material_id: target?.material_id,
                      original_qty: target?.planner_qty ?? target?.suggested_qty,
                      requested_qty: payload.confirmed_qty,
                      reason: payload.reason,
                      requester_name: payload.requester_name,
                      risk_level: "high",
                      status: "pending_review",
                      created_at: actedAt,
                    },
                    ...current.changeRequests,
                  ]
              : current.changeRequests;
          return {
            ...current,
            replenishment,
            changeRequests,
            approvals: [
              {
                approval_id: `APR-DEMO-DISTRICT-${Date.now()}`,
                replenishment_plan_id: planId,
                plan_code: target?.plan_code,
                approval_stage: "district",
                stage: "district",
                decision: payload.decision,
                actor_role: "district",
                approver_name: payload.requester_name,
                district_id: target?.district_id,
                note: payload.reason,
                acted_at: actedAt,
                approved_at: actedAt,
              },
              ...current.approvals,
            ],
          };
        });
      }
      return (await runAction(
        `/v1/replenishment/items/${itemId}/respond`,
        payload,
        "บันทึก District response พร้อมผู้ขอและเหตุผลแล้ว",
      )) !== null;
    },
    [runAction],
  );

  const confirmPendingDistrictItems = useCallback(
    async (planId: string, requesterName: string) => {
      const pendingStatuses = new Set(["draft", "pending"]);
      const pendingRows = data.replenishment.filter(
        (row) =>
          String(row.replenishment_plan_id) === planId &&
          pendingStatuses.has(String(row.item_status)),
      );
      if (!pendingRows.length) return true;

      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => ({
          ...current,
          replenishment: current.replenishment.map((row) => {
            if (
              String(row.replenishment_plan_id) !== planId ||
              !pendingStatuses.has(String(row.item_status))
            ) {
              return row;
            }
            const quantity = Number(row.planner_qty ?? row.suggested_qty ?? row.requested_qty ?? 0);
            return {
              ...row,
              confirmed_qty: quantity,
              requested_qty: quantity,
              final_qty: quantity,
              requester_name: requesterName,
              response_reason: "ยืนยันตามแผนแทนเขตโดยผู้ดูแลระบบ",
              district_note: "ยืนยันตามแผนแทนเขตโดยผู้ดูแลระบบ",
              district_decision: "confirm",
              response_status: quantity > 0 ? "confirmed" : "rejected",
              item_status: quantity > 0 ? "district_confirmed" : "district_rejected",
              district_confirmed_at: actedAt,
              plan_status: "pending_planner_approval",
            };
          }),
        }));
        setNotice(`ยืนยันรายการค้างทั้งแผน ${pendingRows.length} รายการแล้ว (Demo)`);
        window.setTimeout(() => setNotice(""), 4200);
        return true;
      }

      if (!session) return false;
      if (data.readiness?.operational_writes_enabled !== true) {
        setError(
          "ขณะนี้ยังไม่เปิดให้บันทึกข้อมูลจริง เปิดให้อ่านและตรวจข้อมูลได้เท่านั้น",
        );
        return false;
      }

      setActionBusy(true);
      setError("");
      let completed = 0;
      const failures: string[] = [];
      try {
        for (let start = 0; start < pendingRows.length; start += 6) {
          const batch = pendingRows.slice(start, start + 6);
          const results = await Promise.allSettled(
            batch.map((row) =>
              apiRequest(
                `/v1/replenishment/items/${String(row.replenishment_item_id)}/respond`,
                session.access_token,
                {
                  method: "POST",
                  body: JSON.stringify({
                    confirmed_qty: Number(
                      row.planner_qty ?? row.suggested_qty ?? row.requested_qty ?? 0,
                    ),
                    decision: "confirm",
                    reason: "ยืนยันตามแผนแทนเขตโดยผู้ดูแลระบบ เพื่อเตรียม Confirm Plan และจัดรถ",
                    requester_name: requesterName || "ผู้ดูแลระบบ",
                  }),
                },
              ),
            ),
          );
          results.forEach((result, index) => {
            if (result.status === "fulfilled") completed += 1;
            else failures.push(String(batch[index]?.replenishment_item_id ?? "unknown"));
          });
        }
        await load(session);
        if (failures.length) {
          setError(
            `ยืนยันสำเร็จ ${completed}/${pendingRows.length} รายการ ยังไม่สำเร็จ ${failures.length} รายการ กรุณาลองอีกครั้ง`,
          );
          return false;
        }
        setNotice(`ยืนยันรายการค้างทุกเขต ${completed} รายการแล้ว พร้อมให้ Planner ตรวจแผน`);
        window.setTimeout(() => setNotice(""), 5200);
        return true;
      } catch (requestError) {
        await load(session);
        setError(
          requestError instanceof Error
            ? requestError.message
            : "ไม่สามารถยืนยันรายการค้างทุกเขตได้",
        );
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [data.readiness, data.replenishment, load, session],
  );

  const reviewChangeRequest = useCallback(
    async (
      changeRequestId: string,
      decision: "approved" | "rejected",
      reviewNote: string,
    ) => {
      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => {
          const request = current.changeRequests.find(
            (row) => String(row.change_request_id) === changeRequestId,
          );
          const itemId = String(request?.replenishment_item_id ?? "");
          const planId = String(request?.replenishment_plan_id ?? "RP-DEMO-W30");
          const nextItems = current.replenishment.map((row) =>
            String(row.replenishment_item_id) === itemId
              ? {
                  ...row,
                  confirmed_qty:
                    decision === "approved"
                      ? request?.requested_qty
                      : row.planner_qty ?? row.suggested_qty,
                  item_status: decision === "approved" ? "confirmed" : "rejected",
                  response_status: decision === "approved" ? "confirmed" : "rejected",
                }
              : row,
          );
          const complete = nextItems
            .filter((row) => String(row.replenishment_plan_id) === planId)
            .every((row) => ["confirmed", "rejected"].includes(String(row.item_status)));
          return {
            ...current,
            replenishment: nextItems.map((row) =>
              String(row.replenishment_plan_id) === planId
                ? {
                    ...row,
                    plan_status: complete
                      ? "pending_planner_approval"
                      : row.plan_status,
                  }
                : row,
            ),
            changeRequests: current.changeRequests.map((row) =>
              String(row.change_request_id) === changeRequestId
                ? { ...row, status: decision, review_note: reviewNote, reviewed_at: actedAt }
                : row,
            ),
          };
        });
      }
      return (await runAction(
        `/v1/replenishment/change-requests/${changeRequestId}/review`,
        { decision, review_note: reviewNote },
        "บันทึกผล Abnormal Request Review แล้ว",
      )) !== null;
    },
    [runAction],
  );

  const approveReplenishmentPlan = useCallback(
    async (planId: string, note = "") => {
      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => {
          const plan = current.replenishment.find(
            (row) => String(row.replenishment_plan_id) === planId,
          );
          const currentStatus = String(plan?.plan_status ?? "");
          const academicApproval = currentStatus === "pending_academic_approval";
          const nextStatus = academicApproval
            ? "locked"
            : currentStatus === "pending_planner_approval"
              ? "pending_academic_approval"
              : currentStatus;
          if (nextStatus === currentStatus) return current;
          return {
            ...current,
            replenishment: current.replenishment.map((row) =>
              String(row.replenishment_plan_id) === planId
                ? {
                    ...row,
                    plan_status: nextStatus,
                    ...(academicApproval
                      ? { academic_approved_at: actedAt, locked_at: actedAt }
                      : { planner_approved_at: actedAt }),
                  }
                : row,
            ),
            approvals: [
              {
                approval_id: `APR-DEMO-${academicApproval ? "ACADEMIC" : "PLANNER"}-${Date.now()}`,
                replenishment_plan_id: planId,
                plan_code: plan?.plan_code,
                approval_stage: academicApproval ? "academic_lock" : "planner",
                stage: academicApproval ? "academic" : "planner",
                decision: academicApproval ? "approved_and_locked" : "approved",
                actor_role: academicApproval ? "academic" : "planner",
                approver_name: academicApproval ? "Academic Demo" : "Planner Demo",
                note,
                acted_at: actedAt,
                approved_at: actedAt,
              },
              ...current.approvals,
            ],
          };
        });
      }
      return (await runAction(
        `/v1/replenishment/plans/${planId}/approve`,
        { note },
        "บันทึก approval stage และสถานะแผนแล้ว",
      )) !== null;
    },
    [runAction],
  );

  const returnAcademicPlan = useCallback(
    async (planId: string, note: string) => {
      if (!DEMO_MODE) return false;
      const actedAt = new Date().toISOString();
      setData((current) => {
        const plan = current.replenishment.find(
          (row) => String(row.replenishment_plan_id) === planId,
        );
        if (String(plan?.plan_status) !== "pending_academic_approval") return current;
        return {
          ...current,
          replenishment: current.replenishment.map((row) =>
            String(row.replenishment_plan_id) === planId
              ? {
                  ...row,
                  plan_status: "pending_planner_approval",
                  academic_return_note: note,
                  academic_returned_at: actedAt,
                }
              : row,
          ),
          approvals: [
            {
              approval_id: `APR-DEMO-RETURN-${Date.now()}`,
              replenishment_plan_id: planId,
              plan_code: plan?.plan_code,
              approval_stage: "academic",
              stage: "academic",
              decision: "returned_to_planner",
              actor_role: "academic",
              approver_name: "Academic Demo",
              note,
              acted_at: actedAt,
            },
            ...current.approvals,
          ],
        };
      });
      return (await runAction(
        `/demo/replenishment/plans/${planId}/return`,
        { note },
        "ส่งแผนกลับให้ Planner แก้ไขแล้ว",
      )) !== null;
    },
    [runAction],
  );

  const cancelReplenishmentPlan = useCallback(
    async (planId: string, reason: string) =>
      (await runAction(
        `/v1/replenishment/plans/${planId}/cancel`,
        { reason },
        "ยกเลิกแผนและคืน FIFO reservation แล้ว",
      )) !== null,
    [runAction],
  );

  const versionReplenishmentPlan = useCallback(
    async (planId: string, reason: string) =>
      (await runAction(
        `/v1/replenishment/plans/${planId}/version`,
        { reason },
        "สร้าง Plan version ใหม่โดยคง audit ของเวอร์ชันเดิมแล้ว",
      )) !== null,
    [runAction],
  );

  const issueReplenishmentPlan = useCallback(
    async (planId: string) => {
      if (DEMO_MODE) {
        const actedAt = new Date().toISOString();
        setData((current) => ({
          ...current,
          replenishment: current.replenishment.map((row) =>
            String(row.replenishment_plan_id) === planId && row.plan_status === "locked"
              ? { ...row, plan_status: "completed", issued_at: actedAt }
              : row,
          ),
        }));
      }
      return (await runAction(
        `/v1/replenishment/plans/${planId}/issue`,
        {},
        "บันทึกการจ่ายจริงจาก FIFO allocation แล้ว",
      )) !== null;
    },
    [runAction],
  );

  const receiveHandlingUnit = useCallback(
    async (payload: ReceiptPayload) =>
      (await runAction(
        "/v1/inventory/receipts",
        payload,
        "รับ Handling Unit พร้อม lot/contract trace แล้ว",
      )) !== null,
    [runAction],
  );

  const reconcileHandlingUnit = useCallback(
    async (
      handlingUnitId: string,
      resolvedStatus: "OPEN" | "SEALED",
      reason: string,
    ) =>
      (await runAction(
        `/v1/inventory/handling-units/${handlingUnitId}/reconcile`,
        { resolved_status: resolvedStatus, reason },
        "ยืนยัน OPENING_UNKNOWN ด้วยหลักฐานแล้ว",
      )) !== null,
    [runAction],
  );

  const createAdHocIssue = useCallback(
    async (payload: AdHocIssuePayload) =>
      (await runAction(
        "/v1/ad-hoc/issues",
        payload,
        "สร้าง Ad-hoc Issue แยกจาก Weekly Plan แล้ว",
      )) !== null,
    [runAction],
  );

  const approveAdHocIssue = useCallback(
    async (adHocIssueId: string, note: string) =>
      (await runAction(
        `/v1/ad-hoc/issues/${adHocIssueId}/approve`,
        { note },
        "อนุมัติ Ad-hoc Issue และจอง FIFO แล้ว",
      )) !== null,
    [runAction],
  );

  const issueAdHocIssue = useCallback(
    async (adHocIssueId: string) =>
      (await runAction(
        `/v1/ad-hoc/issues/${adHocIssueId}/issue`,
        {},
        "บันทึกการจ่าย Ad-hoc จริงแล้ว",
      )) !== null,
    [runAction],
  );

  const recordInventoryReturn = useCallback(
    async (
      sourceIssueMovementId: string,
      quantity: number,
      damaged: boolean,
      reason: string,
    ) =>
      (await runAction(
        "/v1/inventory/returns",
        {
          source_issue_movement_id: sourceIssueMovementId,
          quantity,
          damaged,
          reason,
        },
        damaged
          ? "รับคืนและย้าย Handling Unit เข้า Quarantine แล้ว"
          : "บันทึกรับคืนโดยเชื่อมกับรายการจ่ายเดิมแล้ว",
      )) !== null,
    [runAction],
  );

  const setDemoRole = useCallback((role: Role) => {
    if (!DEMO_MODE) return;
    setIdentity(demoIdentity(role));
    setNotice(`เปลี่ยนบทบาท Demo เป็น ${role}`);
    window.setTimeout(() => setNotice(""), 2500);
  }, []);

  return {
    actionBusy,
    approveAdHocIssue,
    approveReplenishmentPlan,
    authBusy,
    cancelReplenishmentPlan,
    createAdHocIssue,
    createReplenishmentRun,
    data,
    demoMode: DEMO_MODE,
    error,
    identity,
    issueAdHocIssue,
    issueReplenishmentPlan,
    loadVmiContext,
    loading,
    notice,
    publishFifoOpening,
    publishPackagingProfiles,
    publishVmiInput,
    receiveHandlingUnit,
    reconcileHandlingUnit,
    recordInventoryReturn,
    refresh,
    returnAcademicPlan,
    respondReplenishment,
    confirmPendingDistrictItems,
    submitPlannerSelection,
    reviewChangeRequest,
    session,
    setDemoRole,
    signIn,
    signOut,
    versionReplenishmentPlan,
  };
}
