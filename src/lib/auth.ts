import { useEffect, useState } from "react";
import { type Session } from "@supabase/supabase-js";
import { db } from "./db";
import { supabase } from "./supabase";
import { runFullSync } from "./syncEngine";

const LAST_USER_KEY = "dashboard_last_user_id";

/* ------------------------------------------------------------------ */
/* localStorage helpers (can throw in private mode or when blocked)    */
/* ------------------------------------------------------------------ */

function readLastUser(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

function writeLastUser(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_USER_KEY, id);
    else localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* storage unavailable: user-switch detection just won't persist */
  }
}

/* ------------------------------------------------------------------ */
/* Session hook                                                        */
/* ------------------------------------------------------------------ */

/** Current Supabase session. `loading` is true until the cached session is read. */
export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
        // A user who was already signed in before this module existed:
        // remember them so a later user switch is detected.
        if (data.session && !readLastUser()) {
          writeLastUser(data.session.user.id);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    // Keep this callback synchronous: calling Supabase methods inside it can deadlock.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

/* ------------------------------------------------------------------ */
/* Local data ownership                                                */
/* ------------------------------------------------------------------ */

async function clearLocalUserData(): Promise<void> {
  await Promise.all([db.tasks.clear(), db.expenses.clear()]);
}

/**
 * Call right after a successful sign-in. If a *different* user last used this
 * device, their local rows are wiped so they can't be uploaded into this
 * account. First-ever sign-in keeps existing local data (offline-first adoption).
 * Returns true if local data was cleared.
 */
export async function adoptUser(userId: string): Promise<boolean> {
  const previous = readLastUser();
  let cleared = false;
  if (previous && previous !== userId) {
    await clearLocalUserData();
    cleared = true;
  }
  writeLastUser(userId);
  return cleared;
}

async function countPending(): Promise<number> {
  const [tasks, expenses] = await Promise.all([
    db.tasks.filter((r) => !r.synced || r.deleted === true).count(),
    db.expenses.filter((r) => !r.synced || r.deleted === true).count(),
  ]);
  return tasks + expenses;
}

export type SignOutResult =
  | { status: "signed-out" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Pushes pending changes (when online), warns if any would be lost, signs out,
 * then clears this user's local data. Never throws.
 */
export async function signOutSafely(): Promise<SignOutResult> {
  try {
    if (typeof navigator === "undefined" || navigator.onLine) {
      await runFullSync();
    }

    const pending = await countPending();
    if (pending > 0) {
      const ok = window.confirm(
        `${pending} change${pending === 1 ? " hasn't" : "s haven't"} synced yet. ` +
          "Signing out will delete them from this device. Sign out anyway?"
      );
      if (!ok) return { status: "cancelled" };
    }

    const { error } = await supabase.auth.signOut();
    if (error) {
      return {
        status: "error",
        message: "Couldn't sign out. Check your connection and try again.",
      };
    }

    await clearLocalUserData();
    writeLastUser(null);
    return { status: "signed-out" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Sign out failed.",
    };
  }
}