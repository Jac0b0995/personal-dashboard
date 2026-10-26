import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, RotateCw, Wifi, WifiOff } from "lucide-react";
import {
  getSyncStatus,
  subscribeSyncStatus,
  type SyncState,
} from "../lib/syncEngine";
import { signOutSafely, useSession } from "../lib/auth";

interface HeaderProps {
  /** Called when the user taps the refresh button. May return a promise. */
  onRefresh?: () => void | Promise<void>;
  /** Opens the sign-in modal. Shows a Sign In button when signed out. */
  onSignInClick?: () => void;
}

const SYNC_PILL: Record<
  SyncState,
  { label: string; pill: string; dot: string }
> = {
  synced: {
    label: "Synced",
    pill: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
    dot: "bg-emerald-400",
  },
  syncing: {
    label: "Syncing...",
    pill: "border-yellow-500/30 bg-yellow-500/15 text-yellow-300",
    dot: "bg-yellow-400 animate-pulse",
  },
  offline: {
    label: "Offline",
    pill: "border-slate-500/40 bg-slate-600/30 text-slate-300",
    dot: "bg-slate-400",
  },
  error: {
    label: "Sync Error",
    pill: "border-rose-500/30 bg-rose-500/15 text-rose-300",
    dot: "bg-rose-400",
  },
};

function formatToday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default function Header({ onRefresh, onSignInClick }: HeaderProps) {
  const queryClient = useQueryClient();
  const { session, loading: authLoading } = useSession();

  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [today, setToday] = useState<string>(() => formatToday(new Date()));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const syncState = useSyncExternalStore(
    subscribeSyncStatus,
    getSyncStatus,
    getSyncStatus
  );
  const sync = SYNC_PILL[syncState];

  // Online / offline tracking
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // Keep the date correct if the app stays open past midnight
  useEffect(() => {
    const id = window.setInterval(() => {
      setToday(formatToday(new Date()));
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh?.();
    } finally {
      // Minimum spin time so the feedback is visible even for instant refreshes
      window.setTimeout(() => setIsRefreshing(false), 600);
    }
  }, [isRefreshing, onRefresh]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const result = await signOutSafely();
      if (result.status === "error") {
        window.alert(result.message);
      } else if (result.status === "signed-out") {
        // Local tables were cleared, so refresh the lists.
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["expenses"] });
      }
    } finally {
      setSigningOut(false);
    }
  }, [signingOut, queryClient]);

  const authButtonClasses =
    "inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-slate-700/60 bg-slate-800/80 px-2.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 active:scale-95 disabled:opacity-60";

  return (
    <header className="sticky top-0 z-30 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-slate-50 sm:text-xl">
            Morning Briefing
          </h1>
          <p className="text-xs text-slate-400 sm:text-sm">{today}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {/* Network badge: hidden on narrow screens, where the sync pill covers "Offline". */}
          <span
            role="status"
            aria-live="polite"
            className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium sm:inline-flex ${
              isOnline
                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                : "border-amber-500/30 bg-amber-500/15 text-amber-400"
            }`}
          >
            {isOnline ? (
              <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {isOnline ? "Online" : "Offline"}
          </span>

          {/* Sync status pill */}
          <span
            role="status"
            aria-live="polite"
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-300 ${sync.pill}`}
          >
            <span
              className={`h-2 w-2 rounded-full ${sync.dot}`}
              aria-hidden="true"
            />
            {sync.label}
          </span>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label="Refresh dashboard"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-700/60 bg-slate-800/80 text-slate-300 transition hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 active:scale-95 disabled:opacity-70"
          >
            <RotateCw
              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>

          {/* Auth: Sign Out when a session exists, Sign In otherwise */}
          {!authLoading &&
            (session ? (
              <button
                type="button"
                onClick={() => void handleSignOut()}
                disabled={signingOut}
                aria-label="Sign out"
                title={session.user.email ?? "Sign out"}
                className={authButtonClasses}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            ) : (
              onSignInClick && (
                <button
                  type="button"
                  onClick={onSignInClick}
                  aria-label="Sign in"
                  className={authButtonClasses}
                >
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Sign In</span>
                </button>
              )
            ))}
        </div>
      </div>
    </header>
  );
}