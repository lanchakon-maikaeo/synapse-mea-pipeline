"use client";

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
  alerts: [],
  materials: [],
  districts: [],
  inputSubmissions: [],
  legacyStatus: null,
};

const browserSupabase = isAuthConfigured()
  ? createClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey)
  : null;

export function useSynapseBackend() {
  const authConfigured = isAuthConfigured();
  const [session, setSession] = useState<Session | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(authConfigured);
  const [authBusy, setAuthBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState(
    authConfigured ? "" : "ยังไม่ได้ตั้งค่า Supabase Auth สำหรับ environment นี้",
  );
  const [notice, setNotice] = useState("");
  const sessionTokenRef = useRef<string | null>(null);
  const supabase = browserSupabase;

  const load = useCallback(async (activeSession: Session) => {
    setLoading(true);
    setError("");
    let identityResolved = false;
    try {
      const token = activeSession.access_token;
      const me = await apiRequest<Identity>("/v1/me", token);
      setIdentity(me);
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
              : "unknown API error";
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
        alerts,
        materials,
        districts,
        inputSubmissions,
        warehouseStock,
        legacyStatus,
      });
      if (failures.length) {
        setError(
          `โหลดสำเร็จบางส่วน (${19 - failures.length}/19): ${failures.join(
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

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data: authData }) => {
      if (!active) return;
      if (authData.session) {
        sessionTokenRef.current = authData.session.access_token;
        setSession(authData.session);
        void load(authData.session);
      } else {
        setLoading(false);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        if (
          !active ||
          nextSession?.access_token === sessionTokenRef.current
        ) {
          return;
        }
        sessionTokenRef.current = nextSession?.access_token ?? null;
        setSession(nextSession);
        if (nextSession) void load(nextSession);
        else {
          setIdentity(null);
          setData(emptyData);
          setLoading(false);
        }
      },
    );
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [load, supabase]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      if (!supabase) return false;
      setAuthBusy(true);
      setError("");
      const { data: authData, error: signInError } =
        await supabase.auth.signInWithPassword({
          email: resolveSignInIdentifier(identifier),
          password,
        });
      setAuthBusy(false);
      if (signInError || !authData.session) {
        setError(signInError?.message ?? "ไม่สามารถเข้าสู่ระบบได้");
        return false;
      }
      if (sessionTokenRef.current !== authData.session.access_token) {
        sessionTokenRef.current = authData.session.access_token;
        setSession(authData.session);
        await load(authData.session);
      }
      return true;
    },
    [load, supabase],
  );

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
    sessionTokenRef.current = null;
    setSession(null);
    setIdentity(null);
    setData(emptyData);
    setError("");
    setNotice("");
  }, [supabase]);

  const refresh = useCallback(async () => {
    if (session) await load(session);
  }, [load, session]);

  const runAction = useCallback(
    async <T,>(
      path: string,
      body: unknown,
      successMessage: string,
    ): Promise<T | null> => {
      if (!session) return null;
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
            : "ไม่สามารถดำเนินการกับ backend ได้",
        );
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    [load, session],
  );

  const loadVmiContext = useCallback(
    async (materialId: string, districtId: string) => {
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

  const publishVmiInput = useCallback(
    async (payload: VmiInputPayload) =>
      (await runAction(
        "/v1/data-inputs/vmi",
        payload,
        "เผยแพร่ข้อมูลผ่าน Raw → Staging → Core/Analytics แล้ว",
      )) !== null,
    [runAction],
  );

  const respondReplenishment = useCallback(
    async (itemId: string, payload: ReplenishmentResponsePayload) =>
      (await runAction(
        `/v1/replenishment/items/${itemId}/respond`,
        payload,
        "บันทึก District response พร้อมผู้ขอและเหตุผลแล้ว",
      )) !== null,
    [runAction],
  );

  const reviewChangeRequest = useCallback(
    async (
      changeRequestId: string,
      decision: "approved" | "rejected",
      reviewNote: string,
    ) =>
      (await runAction(
        `/v1/replenishment/change-requests/${changeRequestId}/review`,
        { decision, review_note: reviewNote },
        "บันทึกผล Abnormal Request Review แล้ว",
      )) !== null,
    [runAction],
  );

  const approveReplenishmentPlan = useCallback(
    async (planId: string, note = "") =>
      (await runAction(
        `/v1/replenishment/plans/${planId}/approve`,
        { note },
        "บันทึก approval stage และสถานะแผนแล้ว",
      )) !== null,
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
    async (planId: string) =>
      (await runAction(
        `/v1/replenishment/plans/${planId}/issue`,
        {},
        "บันทึกการจ่ายจริงจาก FIFO allocation แล้ว",
      )) !== null,
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

  return {
    actionBusy,
    approveAdHocIssue,
    approveReplenishmentPlan,
    authBusy,
    cancelReplenishmentPlan,
    createAdHocIssue,
    createReplenishmentRun,
    data,
    error,
    identity,
    issueAdHocIssue,
    issueReplenishmentPlan,
    loadVmiContext,
    loading,
    notice,
    publishVmiInput,
    receiveHandlingUnit,
    reconcileHandlingUnit,
    recordInventoryReturn,
    refresh,
    respondReplenishment,
    reviewChangeRequest,
    session,
    signIn,
    signOut,
    versionReplenishmentPlan,
  };
}
