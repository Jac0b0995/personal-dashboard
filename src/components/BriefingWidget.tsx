import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveQuery } from "dexie";
import {
  Sparkles,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  Sun,
  Flame,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { db, type LocalTask } from '../lib/db';

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

const BRIEFING_KEY = ["executive-briefing"] as const;
const WEATHER_CACHE_ID = "bogota";
const XP_PER_TASK = 10;
const XP_PER_LEVEL = 100;

// Derived from the Dexie table so this file makes no assumption about LocalTask's exports.
type TaskRow = LocalTask;

/** Shape written by WeatherWidget into db.weatherCache. */
interface WeatherSnapshot {
  temperature: number;
  humidity: number;
  wind_speed: number;
  weather_code: number;
  aqi: number | null;
  fetched_at: string;
}

type Tone = "good" | "warn" | "bad" | "neutral";

interface EnvironmentSummary {
  summary: string;
  advice: string;
  tone: Tone;
}

interface Briefing {
  level: number;
  completedCount: number;
  xpProgress: number;
  pendingCount: number;
  focusTasks: TaskRow[];
  procrastinated: TaskRow[];
  spentToday: number;
  expenseCount: number;
  environment: EnvironmentSummary;
}

const TONE_CLASSES: Record<Tone, string> = {
  good: "text-emerald-400",
  warn: "text-yellow-400",
  bad: "text-rose-400",
  neutral: "text-slate-400",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const formatCOP = (n: number) => `$${numberFmt.format(n)} COP`;

/** YYYY-MM-DD in the device's local timezone (matches FinanceWidget). */
const localDateString = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const isHighPriority = (t: TaskRow) =>
  String(t.priority ?? "").toLowerCase() === "high";

const isUniversity = (t: TaskRow) => t.category === "University";

/** 0 = high priority + University, 1 = high priority, 2 = University, 3 = everything else. */
const focusScore = (t: TaskRow) =>
  isHighPriority(t) ? (isUniversity(t) ? 0 : 1) : isUniversity(t) ? 2 : 3;

const byFocus = (a: TaskRow, b: TaskRow) =>
  focusScore(a) - focusScore(b) ||
  String(a.due_date ?? "9999").localeCompare(String(b.due_date ?? "9999"));

function skyLabel(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Mixed conditions";
}

function buildEnvironment(w: WeatherSnapshot | undefined): EnvironmentSummary {
  if (!w) {
    return {
      summary: "No weather saved yet",
      advice: "Open the dashboard online once to load Bogotá conditions.",
      tone: "neutral",
    };
  }

  const temp = Math.round(w.temperature);
  const code = w.weather_code;
  const wet =
    (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

  let summary = `${skyLabel(code)}, ${temp}°C`;
  let tone: Tone = "neutral";
  const advice: string[] = [];

  if (typeof w.aqi === "number") {
    const aqi = Math.round(w.aqi);
    if (aqi <= 50) {
      summary += ` · AQI ${aqi} (Good)`;
      tone = "good";
    } else if (aqi <= 100) {
      summary += ` · AQI ${aqi} (Moderate)`;
      tone = "warn";
      advice.push("Sensitive groups should go easy outdoors.");
    } else {
      summary += ` · AQI ${aqi} (Unhealthy)`;
      tone = "bad";
      advice.push("Limit time outdoors today.");
    }
  }

  if (wet) advice.push("Take an umbrella.");
  if (advice.length === 0) advice.push("Good conditions to get outside.");

  // Flag stale offline data so it isn't mistaken for live conditions.
  const ageHours = (Date.now() - new Date(w.fetched_at).getTime()) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours > 3) {
    advice.push(`(Saved ${Math.round(ageHours)} h ago.)`);
  }

  return { summary, advice: advice.join(" "), tone };
}

/* ------------------------------------------------------------------ */
/* Query function: aggregates local Dexie data                         */
/* ------------------------------------------------------------------ */

async function buildBriefing(): Promise<Briefing> {
  const [tasks, expenses, weather] = await Promise.all([
    db.tasks.toArray(),
    db.expenses.toArray(),
    db.weatherCache.get(WEATHER_CACHE_ID),
  ]);

  // Gamification: same formula as TasksWidget.
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const totalXP = completedCount * XP_PER_TASK;
  const level = Math.floor(totalXP / XP_PER_LEVEL) + 1;
  const xpProgress = totalXP % XP_PER_LEVEL;

  const pending = tasks.filter((t) => t.status === "pending");

  // Priority Focus: top 2 high-priority / University tasks.
  const candidates = pending.filter((t) => focusScore(t) < 3).sort(byFocus);
  const focusTasks = (
    candidates.length > 0 ? candidates : [...pending].sort(byFocus)
  ).slice(0, 2);

  // Procrastination Alert: postponed more than once.
  const procrastinated = pending
    .filter((t) => (t.postpone_count ?? 0) > 1)
    .sort((a, b) => (b.postpone_count ?? 0) - (a.postpone_count ?? 0))
    .slice(0, 3);

  // Financial Pulse: today's spend in COP.
  const today = localDateString();
  const todaysExpenses = expenses.filter((e) => e.expense_date === today);
  const spentToday = todaysExpenses.reduce(
    (sum, e) => sum + (Number(e.amount) || 0),
    0
  );

  return {
    level,
    completedCount,
    xpProgress,
    pendingCount: pending.length,
    focusTasks,
    procrastinated,
    spentToday,
    expenseCount: todaysExpenses.length,
    environment: buildEnvironment(
      weather as unknown as WeatherSnapshot | undefined
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Presentational helper                                               */
/* ------------------------------------------------------------------ */

function HighlightCard({
  title,
  icon: Icon,
  iconClasses,
  children,
}: {
  title: string;
  icon: LucideIcon;
  iconClasses: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-slate-700/50 bg-slate-900/50 p-4 transition-colors duration-200 hover:border-slate-600">
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconClasses}`}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h4 className="text-sm font-semibold text-slate-100">{title}</h4>
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function BriefingWidget() {
  const queryClient = useQueryClient();

  const { data, isPending, isError } = useQuery({
    queryKey: BRIEFING_KEY,
    queryFn: buildBriefing,
    // Reads only IndexedDB, so it must keep working offline.
    networkMode: "always",
  });

  // Other widgets write straight to Dexie, so watch the tables this briefing
  // reads and refresh when any of them change. The first emission is skipped
  // because useQuery already performs the initial load.
  useEffect(() => {
    let isFirst = true;
    const subscription = liveQuery(async () => {
      await Promise.all([
        db.tasks.toArray(),
        db.expenses.toArray(),
        db.weatherCache.toArray(),
      ]);
      return Date.now();
    }).subscribe({
      next: () => {
        if (isFirst) {
          isFirst = false;
          return;
        }
        void queryClient.invalidateQueries({ queryKey: BRIEFING_KEY });
      },
      error: (err) =>
        console.warn("[BriefingWidget] live subscription failed", err),
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  /* ---------------------------- Loading ---------------------------- */

  if (isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="h-10 w-3/4 animate-pulse rounded-lg bg-slate-700/30" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-xl bg-slate-700/30"
            />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-700/60 px-4 py-8 text-sm text-slate-400">
        <AlertCircle className="h-4 w-4 text-amber-400" aria-hidden="true" />
        Couldn't build the briefing from local data.
      </div>
    );
  }

  const {
    level,
    xpProgress,
    pendingCount,
    focusTasks,
    procrastinated,
    spentToday,
    expenseCount,
    environment,
  } = data;

  /* ---------------------------- Content ---------------------------- */

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
            <span
              className="absolute inset-0 animate-pulse rounded-xl bg-amber-400/30 blur-md motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-300">
              <Sparkles
                className="h-5 w-5 animate-pulse drop-shadow-[0_0_6px_rgba(251,191,36,0.8)] motion-reduce:animate-none"
                aria-hidden="true"
              />
            </span>
          </span>
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              AI Morning Executive Briefing
            </h3>
            <p className="text-xs tabular-nums text-slate-400">
              {pendingCount} pending · {xpProgress}/{XP_PER_LEVEL} XP to next
              level
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-300">
          <Zap className="h-3.5 w-3.5" aria-hidden="true" />
          Level {level} Achieved
        </span>
      </div>

      {/* Highlight cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {/* 1. Top Focus Agenda */}
        <HighlightCard
          title="Top Focus Agenda"
          icon={CheckCircle2}
          iconClasses="bg-sky-500/15 text-sky-400"
        >
          {focusTasks.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-3 text-sm text-emerald-300">
              <CheckCircle2
                className="h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              All clear for today
            </div>
          ) : (
            <ol className="space-y-2">
              {focusTasks.map((task, i) => (
                <li
                  key={`${task.id ?? i}-${task.title}`}
                  className="flex items-start gap-2.5 rounded-lg bg-slate-800/60 px-3 py-2"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-[11px] font-bold text-sky-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-slate-100">
                      {task.title}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-400">
                      {isHighPriority(task) && (
                        <Flame
                          className="h-3 w-3 text-orange-400"
                          aria-label="High priority"
                        />
                      )}
                      {task.category}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </HighlightCard>

        {/* 2. Friction & Procrastination Radar */}
        <HighlightCard
          title="Friction & Procrastination Radar"
          icon={AlertCircle}
          iconClasses="bg-amber-500/15 text-amber-400"
        >
          {procrastinated.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-3 text-sm text-emerald-300">
              <CheckCircle2
                className="h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              No friction. Nothing has been put off twice.
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {procrastinated.map((task, i) => (
                  <li
                    key={`${task.id ?? i}-${task.title}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2"
                  >
                    <p className="min-w-0 break-words text-sm font-medium text-slate-100">
                      {task.title}
                    </p>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                      <Flame className="h-3 w-3" aria-hidden="true" />×
                      {task.postpone_count}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-400">
                Do these first, or drop them. Each has slipped more than once.
              </p>
            </>
          )}
        </HighlightCard>

        {/* 3. Daily Snapshot */}
        <HighlightCard
          title="Daily Snapshot"
          icon={TrendingUp}
          iconClasses="bg-emerald-500/15 text-emerald-400"
        >
          <ul className="space-y-3">
            <li className="flex items-start gap-2.5">
              <TrendingUp
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-semibold tabular-nums text-slate-100">
                  {formatCOP(spentToday)} spent today
                </p>
                <p className="text-xs text-slate-400">
                  {expenseCount === 0
                    ? "No expenses logged yet"
                    : `${expenseCount} ${expenseCount === 1 ? "expense" : "expenses"} logged`}
                </p>
              </div>
            </li>

            <li className="flex items-start gap-2.5">
              <Sun
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-400"
                aria-hidden="true"
              />
              <div>
                <p
                  className={`text-sm font-semibold ${TONE_CLASSES[environment.tone]}`}
                >
                  {environment.summary}
                </p>
                <p className="text-xs text-slate-400">{environment.advice}</p>
              </div>
            </li>
          </ul>
        </HighlightCard>
      </div>
    </div>
  );
}