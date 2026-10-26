import Dexie, { type Table, type Transaction } from "dexie";

export interface LocalTask {
  /** Client-generated UUID string (crypto.randomUUID()). Same value as the Supabase id. */
  id: string; // CHANGED: was optional/numeric
  title: string;
  category: string;
  priority: string;
  status: string;
  postpone_count: number;
  xp_reward: number;
  due_date: string;
  synced: boolean;
  deleted?: boolean;
}

export interface LocalExpense {
  id?: number; // UNCHANGED (expenses are not part of this fix)
  description: string;
  amount: number;
  currency: string;
  category: string;
  expense_date: string;
  synced: boolean;
  deleted?: boolean;
}

export interface LocalWeatherCache {
  id: string;
  temperature: number;
  humidity: number;
  wind_speed: number;
  weather_code: number;
  aqi: number | null;
  fetched_at: string;
}

/* ------------------------------------------------------------------ */
/* ADDED: migration helpers (numeric ids -> string ids)                */
/* ------------------------------------------------------------------ */

/** true: Supabase `tasks.id` is a uuid column. false: it's text. */
const SUPABASE_ID_IS_UUID = true;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LegacyTask = Omit<LocalTask, "id"> & { id: number | string };

function migrateTaskRows(rows: LegacyTask[]): LocalTask[] {
  const byId = new Map<string, { task: LocalTask; wasString: boolean }>();

  for (const row of rows) {
    let id = String(row.id);
    let synced = row.synced;

    if (SUPABASE_ID_IS_UUID && !UUID_RE.test(id)) {
      // A numeric id like "1" could never have been stored in a uuid column,
      // so this row only exists locally. Give it a real id and push it as new.
      id = crypto.randomUUID();
      synced = false;
    }

    const next = {
      task: { ...row, id, synced } as LocalTask,
      wasString: typeof row.id === "string",
    };

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, next);
      continue;
    }

    // Same id twice (number 1 vs string "1", text-column mode only):
    // keep the copy with unsynced edits, otherwise the copy pulled from Supabase.
    const nextDirty = !next.task.synced;
    const existingDirty = !existing.task.synced;
    if (nextDirty && !existingDirty) byId.set(id, next);
    else if (nextDirty === existingDirty && next.wasString) byId.set(id, next);
  }

  return [...byId.values()].map((v) => v.task);
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

class AppDB extends Dexie {
  tasks!: Table<LocalTask, string>; // CHANGED: key type is string
  expenses!: Table<LocalExpense, number>;
  weatherCache!: Table<LocalWeatherCache, string>;

  constructor() {
    super("personal-dashboard"); // keep your existing database name

    // Your CURRENT schema, unchanged. Use your real version number and indexes.
    this.version(1).stores({
      tasks: "++id, status, category, due_date",
      expenses: "++id, expense_date, category",
      weatherCache: "id",
    });

    // ADDED Step 1: copy tasks into a staging table that already has the string key.
    this.version(2)
      .stores({ tasks_staging: "id, status, category, due_date" })
      .upgrade(async (tx: Transaction) => {
        const legacy = (await tx.table("tasks").toArray()) as LegacyTask[];
        await tx.table("tasks_staging").bulkPut(migrateTaskRows(legacy));
      });

    // ADDED Step 2: drop the numeric-key table (Dexie can't change a primary key in place).
    this.version(3).stores({ tasks: null });

    // ADDED Step 3: recreate `tasks` with the string key and restore the rows.
    this.version(4)
      .stores({ tasks: "id, status, category, due_date" })
      .upgrade(async (tx: Transaction) => {
        const rows = await tx.table("tasks_staging").toArray();
        await tx.table("tasks").bulkPut(rows);
      });

    // ADDED Step 4: remove the staging table.
    this.version(5).stores({ tasks_staging: null });
  }
}

export const db = new AppDB();