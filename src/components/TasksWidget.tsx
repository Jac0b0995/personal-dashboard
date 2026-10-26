import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ArrowRight,
  Plus,
  Trophy,
  BookOpen,
  Music,
  Users,
  User,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { db, type LocalTask } from "../lib/db";
import { deleteTaskLocal } from "../lib/syncEngine";

const CATEGORIES = ["University", "Music", "Community", "Personal"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_META: Record<Category, { icon: LucideIcon; badge: string }> = {
  University: {
    icon: BookOpen,
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  },
  Music: {
    icon: Music,
    badge: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  },
  Community: {
    icon: Users,
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  Personal: {
    icon: User,
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  },
};

const FALLBACK_META = CATEGORY_META.Personal;

export default function TasksWidget() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("University");

  /* ------------------------------ Query ------------------------------ */

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["tasks"],
    // Soft-deleted rows stay in Dexie until Supabase confirms; hide them here.
    queryFn: () => db.tasks.filter((t) => !t.deleted).toArray(),
    networkMode: "always",
  });

  const invalidateTasks = () =>
    queryClient.invalidateQueries({ queryKey: ["tasks"] });

  /* ---------------------------- Mutations ---------------------------- */

  const addTask = useMutation({
    networkMode: "always",
    mutationFn: ({
      title,
      category,
    }: {
      title: string;
      category: Category;
    }) =>
      db.tasks.add({
        id: crypto.randomUUID(), // CHANGED: string UUID, same value Supabase will store
        title,
        category,
        priority: "medium",
        status: "pending",
        postpone_count: 0,
        xp_reward: 10,
        synced: false,
        due_date: new Date().toISOString(),
      }), // CHANGED: removed the `as LocalTask` cast
    onSuccess: invalidateTasks,
  });

  const completeTask = useMutation({
    networkMode: "always",
    mutationFn: (taskId: string) => // CHANGED: string id
      db.tasks.update(taskId, { status: "completed", synced: false }),
    onSuccess: invalidateTasks,
  });

  const postponeTask = useMutation({
    networkMode: "always",
    mutationFn: (task: LocalTask) =>
      db.tasks.update(task.id, { // CHANGED: no cast needed
        postpone_count: (task.postpone_count || 0) + 1,
        synced: false,
      }),
    onSuccess: invalidateTasks,
  });

  const removeTask = useMutation({
    networkMode: "always",
    mutationFn: (taskId: string) => deleteTaskLocal(taskId), // CHANGED: string id
    onSuccess: invalidateTasks,
  });

  /* ------------------------- Gamification ---------------------------- */

  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const totalXP = completedCount * 10;
  const level = Math.floor(totalXP / 100) + 1;
  const currentProgress = totalXP % 100;

  const pendingTasks = tasks.filter((t) => t.status === "pending");

  /* ----------------------------- Handlers ---------------------------- */

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    addTask.mutate({ title: trimmed, category });
    setTitle("");
  };

  /* ------------------------------ Render ----------------------------- */

  return (
    <div className="flex flex-col gap-5">
      {/* Header: Trophy, level badge, XP progress */}
      <div className="flex items-center gap-4 rounded-xl border border-slate-700/50 bg-slate-900/50 p-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
          <Trophy className="h-6 w-6" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-300">
              Lvl {level}
            </span>
            <span className="text-xs tabular-nums text-slate-400">
              {currentProgress} / 100 XP
            </span>
          </div>

          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-slate-700/60"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={currentProgress}
            aria-label="XP progress to next level"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-400 transition-all duration-500 ease-out"
              style={{ width: `${currentProgress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Add task form */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a task…"
          maxLength={120}
          aria-label="Task title"
          className="min-w-0 flex-1 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500/60 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
        />

        <div className="flex gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
            aria-label="Category"
            className="min-w-0 flex-1 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 transition focus:border-sky-500/60 focus:outline-none focus:ring-2 focus:ring-sky-500/30 sm:flex-none"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <button
            type="submit"
            disabled={!title.trim()}
            aria-label="Add task"
            className="inline-flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-sky-500 text-white transition hover:bg-sky-400 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </form>

      {/* Task list */}
      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-xl bg-slate-700/30"
            />
          ))}
        </div>
      ) : pendingTasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700/60 px-4 py-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
            <Check className="h-6 w-6" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-slate-200">All caught up!</p>
          <p className="text-xs text-slate-500">
            Every task is complete. Add a new one to keep earning XP.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {pendingTasks.map((task) => {
            const meta =
              CATEGORY_META[task.category as Category] ?? FALLBACK_META;
            const CategoryIcon = meta.icon;
            // CHANGED: removed `const taskId = task.id as NonNullable<...>`

            return (
              <li
                key={task.id}
                className="flex items-center gap-3 rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 transition-all duration-200 hover:border-slate-600 hover:bg-slate-900/70"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {task.title}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badge}`}
                    >
                      <CategoryIcon className="h-3 w-3" aria-hidden="true" />
                      {task.category}
                    </span>

                    {(task.postpone_count ?? 0) > 0 && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                        Postponed ×{task.postpone_count}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => removeTask.mutate(task.id)} // CHANGED
                    aria-label={`Delete ${task.title}`}
                    title="Delete"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 active:scale-90"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    onClick={() => postponeTask.mutate(task)}
                    aria-label={`Postpone ${task.title}`}
                    title="Postpone"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/80 text-slate-300 transition hover:bg-amber-500/20 hover:text-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 active:scale-90"
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    onClick={() => completeTask.mutate(task.id)} // CHANGED
                    aria-label={`Complete ${task.title}`}
                    title="Complete"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 transition hover:bg-emerald-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 active:scale-90"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}