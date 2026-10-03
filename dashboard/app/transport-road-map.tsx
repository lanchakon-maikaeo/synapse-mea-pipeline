"use client";

import L from "leaflet";
import { leafletLayer } from "protomaps-leaflet";
import { useEffect, useMemo } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";

export type RoadGeometry = {
  type: "LineString";
  coordinates: Array<[number, number]>;
};

export type RoadMapPoint = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  isDepot: boolean;
  selected?: boolean;
  sequence?: number;
  verificationStatus: "quarantined" | "candidate" | "verified";
  routeEligible: boolean;
};

export type TransportRoadMapProps = {
  points: RoadMapPoint[];
  geometry?: RoadGeometry | null;
  onPick?: (id: string) => void;
};

const fallbackCenter: [number, number] = [13.7563, 100.5018];
const configuredTileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL?.trim() ?? "";
const configuredTileAttribution =
  process.env.NEXT_PUBLIC_MAP_ATTRIBUTION?.trim() ?? "";
const publicOsmTileUrl = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const publicOsmAttribution =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
function controlledProductionTileConfig() {
  if (!configuredTileUrl || !configuredTileAttribution) return null;
  try {
    const url = new URL(configuredTileUrl);
    const hostname = url.hostname.toLowerCase();
    const publicCommunityHost =
      hostname === "tile.openstreetmap.org" ||
      hostname.endsWith(".tile.openstreetmap.org");
    const loopbackHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      publicCommunityHost ||
      loopbackHost ||
      !configuredTileAttribution.includes("OpenStreetMap")
    ) {
      return null;
    }
    const isPmtiles = url.pathname.endsWith(".pmtiles");
    const isXyz =
      configuredTileUrl.includes("{z}") &&
      configuredTileUrl.includes("{x}") &&
      configuredTileUrl.includes("{y}");
    if (!isPmtiles && !isXyz) return null;
    return {
      url: configuredTileUrl,
      attribution: configuredTileAttribution,
      kind: isPmtiles ? ("pmtiles" as const) : ("xyz" as const),
    };
  } catch {
    return null;
  }
}
const tileConfig =
  process.env.NODE_ENV === "production"
    ? controlledProductionTileConfig()
    : configuredTileUrl && configuredTileAttribution
      ? {
          url: configuredTileUrl,
          attribution: configuredTileAttribution,
          kind: configuredTileUrl.endsWith(".pmtiles")
            ? ("pmtiles" as const)
            : ("xyz" as const),
        }
      : {
          url: publicOsmTileUrl,
          attribution: publicOsmAttribution,
          kind: "xyz" as const,
        };

function PmTilesLayer({
  url,
  attribution,
}: {
  url: string;
  attribution: string;
}) {
  const map = useMap();
  useEffect(() => {
    const layer = leafletLayer({
      url,
      attribution,
      flavor: "light",
      lang: "th",
      maxZoom: 18,
      maxDataZoom: 15,
    });
    layer.addTo(map);
    return () => {
      layer.removeFrom(map);
    };
  }, [attribution, map, url]);
  return null;
}

function FitVisibleRoute({ positions }: { positions: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 1) {
      map.setView(positions[0], 12, { animate: false });
    } else if (positions.length > 1) {
      map.fitBounds(positions, {
        animate: false,
        padding: [36, 36],
        maxZoom: 13,
      });
    }
  }, [map, positions]);
  return null;
}

function markerIcon(point: RoadMapPoint) {
  const label = point.isDepot ? "คลัง" : point.sequence ? String(point.sequence) : "•";
  return L.divIcon({
    className: "synapse-map-marker-shell",
    html: `<span class="synapse-map-marker ${point.isDepot ? "depot" : point.selected ? "selected" : ""} ${point.verificationStatus} ${point.routeEligible ? "route-ready" : "route-blocked"}">${label}</span>`,
    iconAnchor: [22, 22],
    iconSize: [44, 44],
  });
}

export function TransportRoadMap({
  points,
  geometry,
  onPick,
}: TransportRoadMapProps) {
  const validPoints = useMemo(
    () =>
      points.filter(
        (point) =>
          Number.isFinite(point.lat) &&
          Number.isFinite(point.lon) &&
          point.lat >= -90 &&
          point.lat <= 90 &&
          point.lon >= -180 &&
          point.lon <= 180,
      ),
    [points],
  );
  const roadPositions = useMemo<Array<[number, number]>>(
    () =>
      geometry?.coordinates
        ?.filter(
          ([lon, lat]) =>
            Number.isFinite(lat) &&
            Number.isFinite(lon) &&
            lat >= -90 &&
            lat <= 90 &&
            lon >= -180 &&
            lon <= 180,
        )
        .map(([lon, lat]) => [lat, lon]) ?? [],
    [geometry],
  );
  const fitPositions = useMemo(
    () =>
      roadPositions.length > 1
        ? roadPositions
        : validPoints.map(
            (point) => [point.lat, point.lon] as [number, number],
          ),
    [roadPositions, validPoints],
  );
  const hasRoadGeometry = roadPositions.length > 1;

  return (
    <div
      className="transport-road-map"
      role="region"
      aria-label="แผนที่เส้นทางขนส่ง"
      aria-describedby="transport-map-legend"
    >
      <MapContainer
        center={fitPositions[0] ?? fallbackCenter}
        zoom={10}
        minZoom={5}
        maxZoom={18}
        scrollWheelZoom={false}
        zoomAnimation={false}
        fadeAnimation={false}
        markerZoomAnimation={false}
      >
        {tileConfig?.kind === "pmtiles" ? (
          <PmTilesLayer
            url={tileConfig.url}
            attribution={tileConfig.attribution}
          />
        ) : tileConfig ? (
          <TileLayer
            url={tileConfig.url}
            attribution={tileConfig.attribution}
            maxZoom={19}
            crossOrigin
          />
        ) : null}
        <FitVisibleRoute positions={fitPositions} />
        {hasRoadGeometry && (
          <Polyline
            positions={roadPositions}
            pathOptions={{
              color: "#e96720",
              weight: 5,
              opacity: 0.9,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )}
        {validPoints.map((point) => (
          <Marker
            key={point.id}
            position={[point.lat, point.lon]}
            icon={markerIcon(point)}
            keyboard
            title={`${point.id} · ${point.name}`}
            alt={`${point.isDepot ? "คลังต้นทาง" : "เขตปลายทาง"} ${point.name}`}
            eventHandlers={
              !point.isDepot && onPick
                ? { click: () => onPick(point.id) }
                : undefined
            }
          >
            <Tooltip direction="top" offset={[0, -14]}>
              <strong>{point.name}</strong>
              <br />
              <span>{point.id}</span>
              <br />
              <span>
                {point.verificationStatus === "verified"
                  ? point.routeEligible
                    ? "พิกัดผ่านการรับรองและพร้อมจัดเส้นทาง"
                    : "พิกัดยืนยันแล้ว แต่ยังไม่เชื่อมกับรหัสสถานที่หลัก"
                  : point.verificationStatus === "candidate"
                    ? "พิกัดเบื้องต้น รอตรวจสอบ"
                    : "พิกัดถูกกักไว้"}
              </span>
            </Tooltip>
          </Marker>
        ))}
      </MapContainer>
      {!tileConfig && (
        <div className="transport-map-config-error" role="alert">
          <strong>แผนที่ฐานยังไม่พร้อมใช้งานในระบบจริง</strong>
          <span>
            ผู้ดูแลระบบต้องตั้งค่า NEXT_PUBLIC_MAP_TILE_URL และ NEXT_PUBLIC_MAP_ATTRIBUTION ให้ครบ ระบบจะไม่ใช้บริการแผนที่ OSM สาธารณะแทน
          </span>
        </div>
      )}
      <div id="transport-map-legend" className="transport-map-legend">
        <span><i className="depot" />คลังต้นทาง</span>
        <span><i className="selected" />จุดส่ง</span>
        <span><i className="candidate" />พิกัดรอตรวจสอบ</span>
        <span><i className="quarantined" />พิกัดกักไว้</span>
        <span><i className="route-blocked" />พิกัดยืนยันแล้ว แต่ยังจัดเส้นทางไม่ได้</span>
        <span>
          <b className={hasRoadGeometry ? "road" : "draft"} />
          {hasRoadGeometry
            ? "เส้นทางถนนที่คำนวณได้"
            : "ยังไม่มีเส้นทางถนน แสดงเฉพาะหมุดที่ยืนยันแล้ว"}
        </span>
      </div>
    </div>
  );
}
