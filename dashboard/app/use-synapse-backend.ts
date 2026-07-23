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
import type {
  ForecastRunPayload,
  RouteJobPayload,
  VmiInputPayload,
} from "./pipeline-validation";

export type {
  ForecastRunPayload,
  RouteJobPayload,
  VmiDemandPoint,
  VmiInputPayload,
} from "./pipeline-validation";

export type RecordRow = Record<string, unknown>;

export type VmiContext = {
  material: RecordRow;
  district: RecordRow;
  stock: RecordRow | null;
  usage_rate: RecordRow | null;
  history: RecordRow[];
};

export type DashboardData = {
  contracts: RecordRow[];
  quality: RecordRow[];
  stock: RecordRow[];
  warehouseStock: RecordRow[];
  replenishment: RecordRow[];
  forecasts: RecordRow[];
  forecastMonitoring: RecordRow[];
  routes: RecordRow[];
  jobs: RecordRow[];
  readiness: RecordRow | null;
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
  forecasts: [],
  forecastMonitoring: [],
  routes: [],
  jobs: [],
  readiness: null,
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
      const broad = me.role !== "district";
      const planner = me.role === "admin" || me.role === "planner";
      const requests = await Promise.all([
        broad
          ? apiRequest<RecordRow[]>("/v1/contracts?limit=100", token)
          : Promise.resolve([]),
        broad
          ? apiRequest<RecordRow[]>("/v1/data-quality?limit=100", token)
          : Promise.resolve([]),
        apiRequest<RecordRow[]>("/v1/stock-health", token),
        apiRequest<RecordRow[]>("/v1/replenishment/queue", token),
        apiRequest<RecordRow[]>("/v1/forecasts/latest", token),
        broad
          ? apiRequest<RecordRow[]>("/v1/forecasts/monitoring", token)
          : Promise.resolve([]),
        broad
          ? apiRequest<RecordRow[]>("/v1/routes/plans", token)
          : Promise.resolve([]),
        broad
          ? apiRequest<RecordRow[]>("/v1/jobs", token)
          : Promise.resolve([]),
        broad
          ? apiRequest<RecordRow>("/v1/wave3/readiness", token)
          : Promise.resolve(null),
        broad
          ? apiRequest<RecordRow>("/v1/operations/health", token)
          : Promise.resolve(null),
        planner
          ? apiRequest<RecordRow[]>("/v1/operations/alerts", token)
          : Promise.resolve([]),
        apiRequest<RecordRow[]>("/v1/reference/materials?limit=2000", token),
        apiRequest<RecordRow[]>("/v1/reference/districts", token),
        apiRequest<RecordRow[]>("/v1/data-inputs/vmi?limit=20", token),
        apiRequest<RecordRow[]>("/v1/warehouse-stock?limit=1000", token),
        apiRequest<RecordRow>("/v1/data-sources/legacy/status", token),
      ]);
      setData({
        contracts: requests[0],
        quality: requests[1],
        stock: requests[2],
        replenishment: requests[3],
        forecasts: requests[4],
        forecastMonitoring: requests[5],
        routes: requests[6],
        jobs: requests[7],
        readiness: requests[8],
        operations: requests[9],
        alerts: requests[10],
        materials: requests[11],
        districts: requests[12],
        inputSubmissions: requests[13],
        warehouseStock: requests[14],
        legacyStatus: requests[15],
      });
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

  const loadJobDetail = useCallback(
    async (jobId: string) => {
      if (!session) return null;
      try {
        return await apiRequest<RecordRow>(
          `/v1/jobs/${jobId}`,
          session.access_token,
        );
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "ไม่สามารถโหลดสถานะ Job ได้",
        );
        return null;
      }
    },
    [session],
  );

  const loadRoutePlanDetail = useCallback(
    async (routePlanId: string) => {
      if (!session) return null;
      try {
        return await apiRequest<RecordRow>(
          `/v1/routes/plans/${routePlanId}`,
          session.access_token,
        );
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "ไม่สามารถโหลดรายละเอียด Route ได้",
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
        "สร้างรอบคำนวณการจ่ายจากข้อมูลที่ตรวจสอบแล้ว",
      )) !== null,
    [runAction],
  );

  const publishVmiInput = useCallback(
    async (payload: VmiInputPayload) =>
      (await runAction(
        "/v1/data-inputs/vmi",
        payload,
        "เผยแพร่ VMI input ผ่าน Raw → Staging → Core/Analytics แล้ว",
      )) !== null,
    [runAction],
  );

  const approveReplenishmentPlan = useCallback(
    async (planId: string) =>
      (await runAction(
        `/v1/replenishment/plans/${planId}/approve`,
        {},
        "อนุมัติแผนการจ่ายและบันทึกผู้ดำเนินการแล้ว",
      )) !== null,
    [runAction],
  );

  const queueForecastRun = useCallback(
    async (payload: ForecastRunPayload) =>
      (await runAction(
        "/v1/forecasts/runs",
        payload,
        "ส่ง Forecast run เข้าคิว background worker แล้ว",
      )) !== null,
    [runAction],
  );

  const queueRouteJob = useCallback(
    async (payload: RouteJobPayload) =>
      (await runAction(
        "/v1/routes/jobs",
        payload,
        "ส่ง Route optimization เข้าคิว background worker แล้ว",
      )) !== null,
    [runAction],
  );

  const reviewRoutePlan = useCallback(
    async (
      routePlanId: string,
      decision: "approved" | "rejected",
      reason: string,
    ) =>
      (await runAction(
        `/v1/routes/plans/${routePlanId}/review`,
        { decision, reason: reason || null },
        decision === "approved"
          ? "อนุมัติ Route plan แล้ว"
          : "ปฏิเสธ Route plan พร้อมบันทึกเหตุผลแล้ว",
      )) !== null,
    [runAction],
  );

  const confirmReplenishment = useCallback(
    async (itemId: string, confirmedQty: number, reason: string) => {
      return (
        (await runAction(
          `/v1/replenishment/items/${itemId}/confirm`,
          { confirmed_qty: confirmedQty, reason },
          "บันทึกการยืนยันรายการพร้อมเหตุผลแล้ว",
        )) !== null
      );
    },
    [runAction],
  );

  return {
    actionBusy,
    approveReplenishmentPlan,
    authBusy,
    confirmReplenishment,
    createReplenishmentRun,
    data,
    error,
    identity,
    loadJobDetail,
    loadRoutePlanDetail,
    loadVmiContext,
    loading,
    notice,
    publishVmiInput,
    queueForecastRun,
    queueRouteJob,
    refresh,
    reviewRoutePlan,
    session,
    signIn,
    signOut,
  };
}
