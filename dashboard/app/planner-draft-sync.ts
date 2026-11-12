"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { apiRequest } from "./lib";
import { text } from "./view-helpers";
import type { RecordRow } from "./use-synapse-backend";
import { emptyPlannerDraft, type PlannerDraft } from "./weekly-plan-view";

// The planner's work in คำนวณการจ่าย is kept on the server, one slice per
// district of the open plan (M36), so it survives a closed browser and is
// shared by every planner on the plan. A copy also stays in this browser as
// a backup for when the server cannot be reached.

export const DISTRICT_IDS = Array.from({ length: 18 }, (_, index) => `55${String(index + 1).padStart(2, "0")}`);
const OPEN_STATUSES = ["draft", "pending_district_confirmation", "district_review"];
const MAP_KEYS = ["quantities", "editedRows", "selectedIds", "skipReasons", "addedIds", "addReasons"] as const;
type MapKey = (typeof MAP_KEYS)[number];

export type DraftSlice = Partial<Record<MapKey, Record<string, unknown>>> & { confirmed?: string };
type ServerSlice = { district_id: string; payload: DraftSlice; updated_by_name?: string | null; updated_at: string };

export type DraftSyncStatus = {
  state: "off" | "loading" | "saving" | "saved" | "error" | "local";
  at?: string;
  message?: string;
  planId?: string;
  byMe?: string;
  mine?: boolean;
  by?: Record<string, { name: string; at: string }>;
};

/** The open plan the calculate page works on: the newest by week and version. */
export function openPlanOf(rows: RecordRow[]) {
  let best: RecordRow | undefined;
  const order = (row: RecordRow) =>
    `${text(row.week_start_date, "")}|${String(Number(row.version_no ?? 0)).padStart(6, "0")}`;
  rows.forEach((row) => {
    if (!OPEN_STATUSES.includes(text(row.plan_status, ""))) return;
    if (!best || order(row) > order(best)) best = row;
  });
  return best ? text(best.replenishment_plan_id, "") : "";
}

export function districtLookup(rows: RecordRow[]) {
  const byId = new Map<string, string>();
  rows.forEach((row) => {
    const district = text(row.district_id, "");
    if (!district) return;
    const id = text(row.replenishment_item_id, "");
    if (id) byId.set(id, district);
    byId.set(`${district}|${text(row.material_id, "")}`, district);
  });
  return byId;
}

function districtOfKey(key: string, draft: PlannerDraft, byId: Map<string, string>) {
  const known = byId.get(key);
  if (known) return known;
  const edited = draft.editedRows[key];
  if (edited) {
    const district = text(edited.district_id, "");
    if (district) return district;
  }
  const prefix = key.split("|")[0];
  return /^55(0[1-9]|1[0-8])$/.test(prefix) ? prefix : "";
}

export function sliceOf(draft: PlannerDraft, district: string, byId: Map<string, string>): DraftSlice | null {
  const slice: DraftSlice = {};
  let empty = true;
  MAP_KEYS.forEach((mapKey) => {
    const source = draft[mapKey] as Record<string, unknown>;
    const part: Record<string, unknown> = {};
    Object.keys(source)
      .sort()
      .forEach((key) => {
        if (districtOfKey(key, draft, byId) === district) part[key] = source[key];
      });
    if (Object.keys(part).length) {
      slice[mapKey] = part;
      empty = false;
    }
  });
  if (draft.confirmedDistricts[district]) {
    slice.confirmed = draft.confirmedDistricts[district];
    empty = false;
  }
  return empty ? null : slice;
}

/** Put one district's slice into the draft, replacing what it had for that district. */
export function withSlice(draft: PlannerDraft, district: string, slice: DraftSlice | null, byId: Map<string, string>) {
  const next: PlannerDraft = { ...draft, confirmedDistricts: { ...draft.confirmedDistricts } };
  MAP_KEYS.forEach((mapKey) => {
    const source = draft[mapKey] as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    Object.keys(source).forEach((key) => {
      if (districtOfKey(key, draft, byId) !== district) kept[key] = source[key];
    });
    (next as unknown as Record<string, unknown>)[mapKey] = { ...kept, ...(slice?.[mapKey] ?? {}) };
  });
  if (slice?.confirmed) next.confirmedDistricts[district] = slice.confirmed;
  else delete next.confirmedDistricts[district];
  return next;
}

// The server stores slices as jsonb, which reorders keys, so compare a
// key-sorted copy.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const sig = (slice: DraftSlice | null) => (slice ? stable(slice) : "");

function readLocal(key: string): PlannerDraft | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? "null") as { draft?: PlannerDraft } | null;
    return saved?.draft ? { ...emptyPlannerDraft, ...saved.draft } : null;
  } catch {
    return null;
  }
}

export function usePlannerDraftSync({
  token,
  userId,
  canEdit,
  loading,
  rows,
  draft,
  setDraft,
}: {
  token: string | null;
  userId: string;
  canEdit: boolean;
  loading: boolean;
  rows: RecordRow[];
  draft: PlannerDraft;
  setDraft: Dispatch<SetStateAction<PlannerDraft>>;
}) {
  const planId = useMemo(() => openPlanOf(rows), [rows]);
  const byId = useMemo(() => districtLookup(rows), [rows]);
  const sessionKey = userId && planId && canEdit ? `${userId}|${planId}` : "";
  const localKey = userId && planId ? `synapse.plannerDraft.v2.${userId}.${planId}` : "";
  const [restored, setRestored] = useState("");
  const [status, setStatus] = useState<DraftSyncStatus>({ state: "off" });
  const [flushTick, setFlushTick] = useState(0);
  const flushed = useRef(0);
  const unsaved = useRef(false);
  const synced = useRef<Record<string, string>>({});
  const baseAt = useRef<Record<string, string>>({});
  const serverOn = useRef(false);
  const pushing = useRef(false);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const remember = useCallback((slices: ServerSlice[]) => {
    const by: Record<string, { name: string; at: string }> = {};
    synced.current = {};
    baseAt.current = {};
    slices.forEach((slice) => {
      synced.current[slice.district_id] = sig(slice.payload);
      baseAt.current[slice.district_id] = slice.updated_at;
      by[slice.district_id] = { name: slice.updated_by_name || "—", at: slice.updated_at };
    });
    return by;
  }, []);

  // 1. Restore once per user and plan: server first, this browser's copy for
  //    districts the server does not have yet (those get pushed up next).
  useEffect(() => {
    if (!sessionKey || loading || restored === sessionKey || !rows.length) return;
    let alive = true;
    const run = async () => {
      setStatus({ state: "loading", planId });
      let local = readLocal(localKey);
      if (!local) {
        // the first version kept one copy per user
        try {
          const old = JSON.parse(window.localStorage.getItem(`synapse.plannerDraft.v1.${userId}`) ?? "null") as
            | { planId?: string; draft?: PlannerDraft }
            | null;
          if (old?.draft && String(old.planId ?? "").split(",").includes(planId)) {
            local = { ...emptyPlannerDraft, ...old.draft };
          }
        } catch {
          // ignore
        }
      }
      let server: ServerSlice[] | null = null;
      if (token) {
        try {
          server = await apiRequest<ServerSlice[]>(`/v1/replenishment/plans/${planId}/draft`, token);
        } catch {
          server = null;
        }
      }
      if (!alive) return;
      let next: PlannerDraft = local ?? { ...emptyPlannerDraft };
      if (server) {
        serverOn.current = true;
        server.forEach((slice) => {
          next = withSlice(next, slice.district_id, slice.payload, byId);
        });
        const by = remember(server);
        setStatus({ state: "saved", planId, by, at: server.map((s) => s.updated_at).sort().pop() });
      } else {
        serverOn.current = false;
        synced.current = {};
        baseAt.current = {};
        setStatus({ state: "local", planId, message: "บันทึกไว้ในเครื่องนี้ (ยังเชื่อมระบบกลางไม่ได้)" });
      }
      // keep what is on screen for the page's search and current district
      setDraft((current) => ({
        ...next,
        searchMode: current.searchMode,
        query: current.query,
        activeDistrict: current.activeDistrict || next.activeDistrict,
        districtTab: current.districtTab,
      }));
      setRestored(sessionKey);
    };
    void run();
    return () => {
      alive = false;
    };
  }, [sessionKey, localKey, loading, restored, rows.length, planId, token, userId, byId, remember, setDraft]);

  // 2. Save: this browser at once, the server a moment after the last change.
  useEffect(() => {
    if (!sessionKey || restored !== sessionKey) return;
    try {
      window.localStorage.setItem(localKey, JSON.stringify({ savedAt: new Date().toISOString(), draft }));
    } catch {
      // storage full or blocked
    }
    if (!serverOn.current || !token) return;
    const changed = DISTRICT_IDS.map((district) => ({ district, slice: sliceOf(draft, district, byId) })).filter(
      ({ district, slice }) => sig(slice) !== (synced.current[district] ?? ""),
    );
    unsaved.current = changed.length > 0;
    if (!changed.length) {
      if (flushTick !== flushed.current) {
        flushed.current = flushTick;
        setStatus((current) => ({ ...current, state: "saved", mine: true, at: new Date().toISOString() }));
      }
      return;
    }
    // a district confirmation, or the บันทึก button, saves at once
    const confirmChanged = changed.some(
      ({ district, slice }) =>
        (slice?.confirmed ?? "") !== ((JSON.parse(synced.current[district] || "{}") as DraftSlice).confirmed ?? ""),
    );
    const now = confirmChanged || flushTick !== flushed.current;
    flushed.current = flushTick;
    setStatus((current) => ({ ...current, state: "saving" }));
    const timer = window.setTimeout(async () => {
      pushing.current = true;
      try {
        const result = await apiRequest<{ saved: string[]; conflicts: string[]; slices: ServerSlice[] }>(
          `/v1/replenishment/plans/${planId}/draft`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              slices: changed.map(({ district, slice }) => ({
                district_id: district,
                payload: slice,
                base_updated_at: baseAt.current[district] ?? null,
              })),
            }),
          },
        );
        const current = draftRef.current;
        let merged = current;
        const serverById = new Map(result.slices.map((slice) => [slice.district_id, slice]));
        // someone else saved these districts first: show theirs
        result.conflicts.forEach((district) => {
          merged = withSlice(merged, district, serverById.get(district)?.payload ?? null, byId);
        });
        const by: Record<string, { name: string; at: string }> = {};
        result.slices.forEach((slice) => {
          by[slice.district_id] = { name: slice.updated_by_name || "—", at: slice.updated_at };
        });
        [...result.saved, ...result.conflicts].forEach((district) => {
          const slice = serverById.get(district);
          if (slice) {
            synced.current[district] = sig(slice.payload);
            baseAt.current[district] = slice.updated_at;
          } else {
            delete synced.current[district];
            delete baseAt.current[district];
          }
        });
        if (result.conflicts.length) setDraft(merged);
        unsaved.current = DISTRICT_IDS.some(
          (district) => sig(sliceOf(draftRef.current, district, byId)) !== (synced.current[district] ?? ""),
        );
        setStatus({
          state: "saved",
          planId,
          by,
          mine: true,
          at: new Date().toISOString(),
          message: result.conflicts.length
            ? `เขต ${result.conflicts.join(", ")} มีคนอื่นบันทึกก่อน ระบบโหลดงานล่าสุดของเขามาให้แล้ว`
            : undefined,
        });
      } catch (reason) {
        setStatus((current) => ({
          ...current,
          state: "error",
          message: `บันทึกเข้าระบบกลางไม่สำเร็จ (${reason instanceof Error ? reason.message : String(reason)}) · ยังเก็บไว้ในเครื่องนี้ ระบบจะลองใหม่`,
        }));
      } finally {
        pushing.current = false;
      }
    }, now ? 0 : 1200);
    return () => window.clearTimeout(timer);
  }, [draft, flushTick, sessionKey, restored, localKey, token, planId, byId, remember, setDraft]);

  // ask before closing the page while work is not on the server yet
  useEffect(() => {
    if (!sessionKey) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!serverOn.current || (!unsaved.current && !pushing.current)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [sessionKey]);

  // 3. Every 20 s pull what other planners saved, for districts this
  //    browser has not changed since its last save.
  useEffect(() => {
    if (!sessionKey || restored !== sessionKey || !token) return;
    const tick = async () => {
      if (document.hidden || pushing.current || !serverOn.current) return;
      let server: ServerSlice[];
      try {
        server = await apiRequest<ServerSlice[]>(`/v1/replenishment/plans/${planId}/draft`, token);
      } catch {
        return;
      }
      if (pushing.current) return;
      const current = draftRef.current;
      let merged = current;
      let touched = false;
      const serverById = new Map(server.map((slice) => [slice.district_id, slice]));
      const by: Record<string, { name: string; at: string }> = {};
      DISTRICT_IDS.forEach((district) => {
        const remote = serverById.get(district);
        if (remote) by[district] = { name: remote.updated_by_name || "—", at: remote.updated_at };
        const remoteSig = sig(remote?.payload ?? null);
        const lastSig = synced.current[district] ?? "";
        if (remoteSig === lastSig) return;
        const localSig = sig(sliceOf(current, district, byId));
        // unsaved work here: keep it, and keep the old base so saving it is
        // checked against the newer server copy
        if (localSig !== lastSig) return;
        merged = withSlice(merged, district, remote?.payload ?? null, byId);
        touched = true;
        if (remote) {
          synced.current[district] = remoteSig;
          baseAt.current[district] = remote.updated_at;
        } else {
          delete synced.current[district];
          delete baseAt.current[district];
        }
      });
      if (touched) setDraft(merged);
      setStatus((state) => ({ ...state, by }));
    };
    const timer = window.setInterval(() => void tick(), 20000);
    return () => window.clearInterval(timer);
  }, [sessionKey, restored, token, planId, byId, remember, setDraft]);

  // retry a failed save every 15 s
  useEffect(() => {
    if (status.state !== "error") return;
    const timer = window.setTimeout(() => setDraft((current) => ({ ...current })), 15000);
    return () => window.clearTimeout(timer);
  }, [status.state, setDraft]);

  const reset = useCallback(() => setRestored(""), []);
  const saveNow = useCallback(() => setFlushTick((tick) => tick + 1), []);
  return { status, planId, reset, saveNow };
}
