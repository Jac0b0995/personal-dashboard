import { type Table } from "dexie";
import { db, type LocalTask, type LocalExpense } from "./db";
import { supabase } from "./supabase";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface SyncResult {
  /** Rows upserted to Supabase and marked `synced: true` locally. */
  synced: number;
  /** Soft-deleted rows removed from Supabase and purged locally. */
  deleted: number;
  /** First error message encountered, or null if everything went through. */
  error: string | null;
}

export interface PullResult {
  /** Remote rows written into Dexie (rows protected by local edits excluded). */
  pulled: number;
  /** First error message encountered, or null if the pull went through. */
  error: string | null;
}

export type SyncStatus =
  | "success" // everything went through (or there was nothing to do)
  | "partial" // some progress, but at least one error
  | "failed" // no progress and at least one error
  | "offline" // navigator.onLine === false
  | "unauthenticated"; // no Supabase session

/** Live state shown in the UI (see getSyncStatus / subscribeSyncStatus). */
export type SyncState = "synced" | "syncing" | "offline" | "error";

export interface PullSummary {
  status: "success" | "offline" | "unauthenticated" | "failed";
  pulledCount: number;
  tasksPulled: number;
  expensesPulled: number;
  errors: string[];
}

export interface SyncSummary {
  status: SyncStatus;
  /** Rows pushed to Supabase and marked synced. */
  syncedCount: number;
  /** Rows deleted from Supabase (and purged from Dexie). */
  deletedCount: number;
  /** Rows pulled from Supabase into Dexie. */
  pulledCount: number;
  tasksSynced: number;
  expensesSynced: number;
  tasksDeleted: number;
  expensesDeleted: number;
  tasksPulled: number;
  expensesPulled: number;
  errors: string[];
}

/** Anything with an optional local id, a synced flag (boolean or 0/1) and a deleted flag. */
interface Syncable {
  id?: unknown;
  synced?: unknown;
  deleted?: unknown;
}

type RemoteRow = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* Sync status store (external store for React's useSyncExternalStore) */
/* ------------------------------------------------------------------ */

const isOffline = () =>
  typeof navigator !== "undefined" && !navigator.onLine;

let currentStatus: SyncState = isOffline() ? "offline" : "synced";
const statusListeners = new Set<(status: SyncState) => void>();

export function getSyncStatus(): SyncState {
  return currentStatus;
}

/** Subscribes to status changes. Returns an unsubscribe function. */
export function subscribeSyncStatus(
  cb: (status: SyncState) => void
): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function setStatus(next: SyncState): void {
  if (next === currentStatus) return;
  currentStatus = next;
  statusListeners.forEach((listener) => {
    try {
      listener(next);
    } catch (err) {
      console.warn("[syncEngine] status listener threw", err);
    }
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => {
    if (currentStatus !== "syncing") setStatus("offline");
  });
  // Coalesced with any other caller (e.g. App.tsx) through the in-flight guard.
  window.addEventListener("online", () => {
    void runFullSync();
  });
}

/* ------------------------------------------------------------------ */
/* Constants & helpers                                                 */
/* ------------------------------------------------------------------ */

const PUSH_BATCH_SIZE = 200;
/** Supabase returns at most 1000 rows per request by default. */
const PULL_PAGE_SIZE = 1000;

const errMsg = (err: unknown): string =>
  err instanceof Error
    ? err.message
    : typeof err === "string"
      ? err
      : "Unknown sync error";

const isDeleted = (row: Syncable) => row.deleted === true;

/** A row needs pushing if it has unsynced edits (false or 0) or is soft-deleted. */
const isPending = (row: Syncable) => !row.synced || isDeleted(row);

/** Row as it should be sent to Supabase: no local-only flags, plus the owner. */
function toRemote<T extends Syncable>(row: T, userId: string) {
  const { synced: _synced, deleted: _deleted, ...rest } = row;
  return { ...rest, user_id: userId };
}

/** Comparable fingerprint of a row ignoring the sync flag (the deleted flag counts). */
function fingerprint(row: Syncable): string {
  const { synced: _synced, ...rest } = row;
  return JSON.stringify(rest);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function getUserId(): Promise<string | null> {
  try {
    // Reads the cached session, so it works without a network round trip.
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Local soft delete                                                   */
/* ------------------------------------------------------------------ */

async function markDeleted(
  table: Table<any, any>,
  id: string | number
): Promise<void> {
  // Works offline: this only touches IndexedDB.
  await table.update(id, { deleted: true, synced: false });
  // Background sync: a no-op offline, and the 'online' event retries later.
  void runFullSync();
}

/** Hides the task immediately and queues the remote delete. */
export function deleteTaskLocal(id: string): Promise<void> { // CHANGED: id is a string
  return markDeleted(db.tasks, id);
}

/** Hides the expense immediately and queues the remote delete. */
export function deleteExpenseLocal(id: string | number): Promise<void> {
  return markDeleted(db.expenses, id);
}

/* ------------------------------------------------------------------ */
/* Push: Dexie → Supabase                                              */
/* ------------------------------------------------------------------ */

/**
 * Flags rows as synced, but only if they haven't been edited since the
 * snapshot was taken. Edits made mid-sync (including a delete) keep
 * `synced: false` and get pushed on the next run.
 */
async function markSynced<T extends Syncable>(
  table: Table<T, any>,
  snapshot: T[]
): Promise<void> {
  await table.db.transaction("rw", table, async () => {
    for (const sent of snapshot) {
      if (sent.id === undefined || sent.id === null) continue;
      const current = await table.get(sent.id);
      if (current && fingerprint(current) === fingerprint(sent)) {
        await table.update(sent.id, { synced: true } as any);
      }
    }
  });
}

/**
 * Shared push routine. First removes soft-deleted rows from Supabase and
 * purges them locally, then upserts the remaining unsynced rows in batches.
 * Never throws.
 */
async function pushUnsynced<T extends Syncable>(
  label: string,
  table: Table<T, any>,
  remoteTable: string
): Promise<SyncResult> {
  let synced = 0;
  let deleted = 0;
  let error: string | null = null;

  try {
    // Booleans can't be indexed in IndexedDB, so filter in memory.
    const pending = await table.filter(isPending).toArray();
    if (pending.length === 0) return { synced: 0, deleted: 0, error: null };

    const userId = await getUserId();
    if (!userId) {
      return { synced: 0, deleted: 0, error: `${label}: not signed in` };
    }

    const toDelete = pending.filter(isDeleted);
    const toUpsert = pending.filter((row) => !isDeleted(row));

    /* 1) Deletes: remote first, local purge only after Supabase confirms. */
    for (const row of toDelete) {
      if (row.id === undefined || row.id === null) continue;
      try {
        const { error: sbError } = await supabase
          .from(remoteTable)
          .delete()
          .eq("id", row.id as string);

        if (sbError) {
          error ??= `${label}: ${sbError.message}`;
          continue; // stays soft-deleted locally and retries next run
        }

        await table.delete(row.id);
        deleted += 1;
      } catch (err) {
        error ??= `${label}: ${errMsg(err)}`;
      }
    }

    /* 2) Upserts for everything else. */
    for (const batch of chunk(toUpsert, PUSH_BATCH_SIZE)) {
      try {
        const { error: sbError } = await supabase
          .from(remoteTable)
          .upsert(batch.map((row) => toRemote(row, userId)));

        if (sbError) {
          error ??= `${label}: ${sbError.message}`;
          continue; // leave this batch unsynced, try the next one
        }

        await markSynced(table, batch);
        synced += batch.length;
      } catch (err) {
        // Network dropped mid-request, or the local write failed.
        error ??= `${label}: ${errMsg(err)}`;
      }
    }
  } catch (err) {
    error ??= `${label}: ${errMsg(err)}`;
  }

  return { synced, deleted, error };
}

export function syncUnsyncedTasks(): Promise<SyncResult> {
  return pushUnsynced<LocalTask>("tasks", db.tasks, "tasks");
}

export function syncUnsyncedExpenses(): Promise<SyncResult> {
  return pushUnsynced<LocalExpense>("expenses", db.expenses, "expenses");
}

/* ------------------------------------------------------------------ */
/* Pull: Supabase → Dexie                                              */
/* ------------------------------------------------------------------ */

/** Remote task row → local shape (drops `user_id`, marks as synced). */
function normalizeTask(row: RemoteRow): LocalTask {
  const { user_id: _userId, ...rest } = row;
  return {
    ...rest,
    id: String(rest.id), // CHANGED: always a string, even if Supabase returns a number
    postpone_count: Number(rest.postpone_count ?? 0),
    synced: true,
  } as unknown as LocalTask;
}

/** Remote expense row → local shape (drops `user_id`, marks as synced). */
function normalizeExpense(row: RemoteRow): LocalExpense {
  const { user_id: _userId, ...rest } = row;
  return {
    ...rest,
    // Postgres `numeric` columns arrive as strings.
    amount: Number(rest.amount),
    // Keep the local YYYY-MM-DD format even if the column returns a timestamp.
    expense_date:
      typeof rest.expense_date === "string"
        ? rest.expense_date.slice(0, 10)
        : rest.expense_date,
    synced: true,
  } as unknown as LocalExpense;
}

/**
 * Shared pull routine: download every row the user owns (paged), then write
 * them into Dexie in one transaction, skipping any row that is pending a push
 * (unsynced edits or a queued delete). Never throws.
 */
async function pullTable<T extends Syncable>(
  label: string,
  table: Table<T, any>,
  remoteTable: string,
  normalize: (row: RemoteRow) => T
): Promise<PullResult> {
  try {
    const userId = await getUserId();
    if (!userId) return { pulled: 0, error: `${label}: not signed in` };

    // 1) Network phase (kept outside the Dexie transaction).
    const remoteRows: RemoteRow[] = [];
    for (let from = 0; ; from += PULL_PAGE_SIZE) {
      const { data, error } = await supabase
        .from(remoteTable)
        .select("*")
        .eq("user_id", userId)
        .order("id", { ascending: true }) // stable order for paging
        .range(from, from + PULL_PAGE_SIZE - 1);

      if (error) return { pulled: 0, error: `${label}: ${error.message}` };
      if (!data || data.length === 0) break;

      remoteRows.push(...(data as RemoteRow[]));
      if (data.length < PULL_PAGE_SIZE) break;
    }

    if (remoteRows.length === 0) return { pulled: 0, error: null };
    const incoming = remoteRows.map(normalize);

    // 2) Local phase: atomic check-then-write so no edit can slip in between.
    let pulled = 0;
    await table.db.transaction("rw", table, async () => {
      const locals = await table.bulkGet(incoming.map((r) => r.id) as any[]);
      const toWrite = incoming.filter((_, i) => {
        const local = locals[i];
        // Never clobber pending edits, and never resurrect a queued delete.
        return !local || !isPending(local);
      });
      if (toWrite.length > 0) await table.bulkPut(toWrite);
      pulled = toWrite.length;
    });

    return { pulled, error: null };
  } catch (err) {
    return { pulled: 0, error: `${label}: ${errMsg(err)}` };
  }
}

export function pullRemoteTasks(): Promise<PullResult> {
  return pullTable<LocalTask>("tasks", db.tasks, "tasks", normalizeTask);
}

export function pullRemoteExpenses(): Promise<PullResult> {
  return pullTable<LocalExpense>(
    "expenses",
    db.expenses,
    "expenses",
    normalizeExpense
  );
}

export async function pullRemoteChanges(): Promise<PullSummary> {
  if (isOffline()) {
    console.log("Device offline. Skipping pull.");
    return {
      status: "offline",
      pulledCount: 0,
      tasksPulled: 0,
      expensesPulled: 0,
      errors: [],
    };
  }

  const [tasksRes, expensesRes] = await Promise.allSettled([
    pullRemoteTasks(),
    pullRemoteExpenses(),
  ]);

  const errors: string[] = [];
  let tasksPulled = 0;
  let expensesPulled = 0;

  if (tasksRes.status === "fulfilled") {
    tasksPulled = tasksRes.value.pulled;
    if (tasksRes.value.error) errors.push(tasksRes.value.error);
  } else {
    errors.push(`tasks: ${errMsg(tasksRes.reason)}`);
  }

  if (expensesRes.status === "fulfilled") {
    expensesPulled = expensesRes.value.pulled;
    if (expensesRes.value.error) errors.push(expensesRes.value.error);
  } else {
    errors.push(`expenses: ${errMsg(expensesRes.reason)}`);
  }

  const signedOut =
    errors.length > 0 && errors.every((e) => e.includes("not signed in"));

  let status: PullSummary["status"];
  if (signedOut) status = "unauthenticated";
  else if (errors.length > 0) status = "failed";
  else status = "success";

  if (errors.length > 0) {
    console.warn("[syncEngine] pull completed with errors:", errors);
  }

  return {
    status,
    pulledCount: tasksPulled + expensesPulled,
    tasksPulled,
    expensesPulled,
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* Full bidirectional sync                                             */
/* ------------------------------------------------------------------ */

let inFlight: Promise<SyncSummary> | null = null;

function emptySummary(
  status: SyncStatus,
  errors: string[] = []
): SyncSummary {
  return {
    status,
    syncedCount: 0,
    deletedCount: 0,
    pulledCount: 0,
    tasksSynced: 0,
    expensesSynced: 0,
    tasksDeleted: 0,
    expensesDeleted: 0,
    tasksPulled: 0,
    expensesPulled: 0,
    errors,
  };
}

async function performSync(): Promise<SyncSummary> {
  if (isOffline()) {
    console.log("Device offline. Skipping sync.");
    setStatus("offline");
    return emptySummary("offline");
  }

  setStatus("syncing");

  /* 1) Push local changes (deletes + upserts) so the pull can't clobber them. */
  const [tasksRes, expensesRes] = await Promise.allSettled([
    syncUnsyncedTasks(),
    syncUnsyncedExpenses(),
  ]);

  const errors: string[] = [];
  let tasksSynced = 0;
  let expensesSynced = 0;
  let tasksDeleted = 0;
  let expensesDeleted = 0;

  if (tasksRes.status === "fulfilled") {
    tasksSynced = tasksRes.value.synced;
    tasksDeleted = tasksRes.value.deleted;
    if (tasksRes.value.error) errors.push(tasksRes.value.error);
  } else {
    errors.push(`tasks: ${errMsg(tasksRes.reason)}`);
  }

  if (expensesRes.status === "fulfilled") {
    expensesSynced = expensesRes.value.synced;
    expensesDeleted = expensesRes.value.deleted;
    if (expensesRes.value.error) errors.push(expensesRes.value.error);
  } else {
    errors.push(`expenses: ${errMsg(expensesRes.reason)}`);
  }

  /* 2) Pull the latest cloud state. */
  const pull = await pullRemoteChanges();
  errors.push(...pull.errors);

  /* 3) Aggregate. */
  const syncedCount = tasksSynced + expensesSynced;
  const deletedCount = tasksDeleted + expensesDeleted;
  const pulledCount = pull.pulledCount;

  const signedOut =
    errors.length > 0 && errors.every((e) => e.includes("not signed in"));

  let status: SyncStatus;
  if (signedOut) status = "unauthenticated";
  else if (errors.length === 0) status = "success";
  else if (syncedCount + deletedCount + pulledCount > 0) status = "partial";
  else status = "failed";

  if (errors.length > 0) {
    console.warn("[syncEngine] completed with errors:", errors);
  }

  // If the connection dropped mid-sync, show Offline rather than an error.
  setStatus(isOffline() ? "offline" : status === "success" ? "synced" : "error");

  return {
    status,
    syncedCount,
    deletedCount,
    pulledCount,
    tasksSynced,
    expensesSynced,
    tasksDeleted,
    expensesDeleted,
    tasksPulled: pull.tasksPulled,
    expensesPulled: pull.expensesPulled,
    errors,
  };
}

/**
 * Bidirectional sync: push local changes (deletes and upserts), then pull the
 * cloud state. Safe to call from anywhere, any time: it never throws, and
 * overlapping calls share the same in-flight run.
 */
export function runFullSync(): Promise<SyncSummary> {
  if (!inFlight) {
    inFlight = performSync()
      .catch((err): SyncSummary => {
        setStatus(isOffline() ? "offline" : "error");
        return emptySummary("failed", [errMsg(err)]);
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}