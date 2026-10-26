import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CloudSun,
  Sun,
  CloudRain,
  Wind,
  Droplets,
  MapPin,
  Activity,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { db, type LocalWeatherCache } from "../lib/db";

/* ------------------------------------------------------------------ */
/* Constants & types                                                   */
/* ------------------------------------------------------------------ */

const LATITUDE = 4.6097;
const LONGITUDE = -74.0817;
const CACHE_ID = "bogota";

const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`;
const AQI_URL = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LATITUDE}&longitude=${LONGITUDE}&current=us_aqi`;

interface WeatherSnapshot {
  id: string;
  temperature: number; // °C
  humidity: number; // %
  wind_speed: number; // km/h
  weather_code: number; // WMO code
  aqi: number | null; // US AQI
  fetched_at: string; // ISO timestamp
}

interface WeatherResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
}

interface AqiResponse {
  current?: { us_aqi?: number | null };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function readCache(): Promise<WeatherSnapshot | null> {
  try {
    const row = await db.weatherCache.get(CACHE_ID);
    return (row as unknown as WeatherSnapshot | undefined) ?? null;
  } catch {
    return null;
  }
}

async function fetchWeatherAndAqi(): Promise<WeatherSnapshot> {
  const [weatherResult, aqiResult] = await Promise.allSettled([
    fetchJson<WeatherResponse>(WEATHER_URL),
    fetchJson<AqiResponse>(AQI_URL),
  ]);

  // Weather is required; AQI is optional so one failing API doesn't blank the card.
  if (weatherResult.status === "rejected") throw weatherResult.reason;

  const c = weatherResult.value.current;
  if (
    !c ||
    typeof c.temperature_2m !== "number" ||
    typeof c.relative_humidity_2m !== "number" ||
    typeof c.weather_code !== "number" ||
    typeof c.wind_speed_10m !== "number"
  ) {
    throw new Error("Unexpected weather response shape");
  }

  let aqi: number | null = null;
  const liveAqi =
    aqiResult.status === "fulfilled"
      ? aqiResult.value.current?.us_aqi
      : undefined;
  if (typeof liveAqi === "number") {
    aqi = Math.round(liveAqi);
  } else {
    // AQI request failed or returned nothing: keep the last known value.
    aqi = (await readCache())?.aqi ?? null;
  }

  const snapshot: WeatherSnapshot = {
    id: CACHE_ID,
    temperature: c.temperature_2m,
    humidity: c.relative_humidity_2m,
    wind_speed: c.wind_speed_10m,
    weather_code: c.weather_code,
    aqi,
    fetched_at: new Date().toISOString(),
  };

  // A failed cache write must never hide fresh data from the UI.
  try {
    await db.weatherCache.put(snapshot as unknown as LocalWeatherCache);
  } catch (err) {
    console.warn("[WeatherWidget] could not write weather cache", err);
  }

  return snapshot;
}

/** WMO weather interpretation codes → label + icon. */
function describeWeather(code: number): { label: string; icon: LucideIcon } {
  if (code === 0) return { label: "Clear", icon: Sun };
  if (code === 1) return { label: "Mostly Clear", icon: Sun };
  if (code === 2) return { label: "Partly Cloudy", icon: CloudSun };
  if (code === 3) return { label: "Overcast", icon: CloudSun };
  if (code === 45 || code === 48) return { label: "Foggy", icon: CloudSun };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: CloudRain };
  if (code >= 61 && code <= 67) return { label: "Rain", icon: CloudRain };
  if (code >= 71 && code <= 77) return { label: "Snow", icon: CloudRain };
  if (code >= 80 && code <= 82)
    return { label: "Rain Showers", icon: CloudRain };
  if (code === 85 || code === 86)
    return { label: "Snow Showers", icon: CloudRain };
  if (code >= 95) return { label: "Thunderstorm", icon: CloudRain };
  return { label: "Partly Cloudy", icon: CloudSun };
}

function aqiRating(aqi: number): { label: string; classes: string } {
  if (aqi <= 50) {
    return {
      label: "Good",
      classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    };
  }
  if (aqi <= 100) {
    return {
      label: "Moderate",
      classes: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    };
  }
  return {
    label: "Unhealthy",
    classes: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  };
}

function formatAgo(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function WeatherWidget() {
  const [cached, setCached] = useState<WeatherSnapshot | null>(null);
  const [cacheChecked, setCacheChecked] = useState(false);

  // Load the last saved conditions from Dexie so they show instantly, even offline.
  useEffect(() => {
    let cancelled = false;
    readCache().then((row) => {
      if (cancelled) return;
      setCached(row);
      setCacheChecked(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const query = useQuery({
    queryKey: ["weather-and-aqi"],
    queryFn: fetchWeatherAndAqi,
    staleTime: 10 * 60 * 1000, // 10 min
    refetchInterval: 15 * 60 * 1000, // 15 min
    retry: 1,
    // Fail fast offline instead of pausing, so cached data is shown right away.
    networkMode: "always",
  });

  // Live data wins; otherwise fall back to whatever Dexie had.
  const data = query.data ?? cached;
  const hasFailed = query.isError;

  /* ---------------------------- Loading ---------------------------- */

  if (!data && (query.isPending || !cacheChecked)) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-slate-700/30" />
        <div className="h-28 animate-pulse rounded-xl bg-slate-700/30" />
        <div className="h-10 animate-pulse rounded-xl bg-slate-700/30" />
      </div>
    );
  }

  /* ------------------- Error with nothing cached ------------------- */

  if (!data) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-700/60 px-4 py-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
          <CloudSun className="h-6 w-6" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-slate-200">
          Weather unavailable
        </p>
        <p className="text-xs text-slate-500">
          You're offline and there's no saved forecast yet.
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-700 active:scale-95"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  /* ---------------------------- Content ---------------------------- */

  const { label, icon: WeatherIcon } = describeWeather(data.weather_code);
  const rating = data.aqi !== null ? aqiRating(data.aqi) : null;

  let statusText: string;
  if (hasFailed) statusText = `Offline · saved ${formatAgo(data.fetched_at)}`;
  else if (!query.data) statusText = `Saved ${formatAgo(data.fetched_at)} · updating…`;
  else statusText = `Updated ${formatAgo(data.fetched_at)}`;

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
            <CloudSun className="h-5 w-5" aria-hidden="true" />
          </span>
          <h3 className="text-base font-semibold text-slate-100">
            Weather &amp; Environment
          </h3>
        </div>

        <span className="inline-flex items-center gap-1 rounded-full border border-slate-600/50 bg-slate-700/40 px-2.5 py-1 text-xs font-medium text-slate-300">
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
          Bogotá
        </span>
      </div>

      {/* Main metrics */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-5xl font-bold tabular-nums tracking-tight text-slate-50">
              {Math.round(data.temperature)}
              <span className="text-3xl font-semibold text-slate-400">°C</span>
            </p>
            <p className="mt-1 text-sm font-medium text-slate-300">{label}</p>
          </div>

          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-400">
            <WeatherIcon className="h-9 w-9" aria-hidden="true" />
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2.5 rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-2.5">
            <Droplets
              className="h-4 w-4 shrink-0 text-sky-400"
              aria-hidden="true"
            />
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Humidity
              </p>
              <p className="text-sm font-semibold tabular-nums text-slate-100">
                {Math.round(data.humidity)}%
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-2.5">
            <Wind
              className="h-4 w-4 shrink-0 text-slate-300"
              aria-hidden="true"
            />
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">
                Wind
              </p>
              <p className="text-sm font-semibold tabular-nums text-slate-100">
                {Math.round(data.wind_speed)} km/h
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* AQI + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <span className="text-sm text-slate-400">Air quality</span>
          {rating && data.aqi !== null ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${rating.classes}`}
            >
              <span className="tabular-nums">AQI {data.aqi}</span>
              <span aria-hidden="true">·</span>
              {rating.label}
            </span>
          ) : (
            <span className="rounded-full border border-slate-600/50 bg-slate-700/40 px-2.5 py-0.5 text-xs font-medium text-slate-400">
              Unavailable
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`text-[11px] ${hasFailed ? "text-amber-400" : "text-slate-500"}`}
            role="status"
          >
            {statusText}
          </span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh weather"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/80 text-slate-300 transition hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 active:scale-90 disabled:opacity-70"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  );
}