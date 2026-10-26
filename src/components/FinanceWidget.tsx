import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DollarSign,
  Plus,
  TrendingUp,
  Receipt,
  Calendar,
  Trash2,
} from "lucide-react";
import { db, type LocalExpense } from "../lib/db";
import { deleteExpenseLocal } from "../lib/syncEngine";

const CATEGORIES = ["Food", "Transport", "Uni", "General"] as const;
type Category = (typeof CATEGORIES)[number];

const FILTERS = ["All", ...CATEGORIES] as const;
type Filter = (typeof FILTERS)[number];

const CATEGORY_STYLES: Record<Category, string> = {
  Food: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  Transport: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Uni: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  General: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};

const FALLBACK_RATE = 4000;

const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const formatCOP = (n: number) => `$${numberFmt.format(n)} COP`;

/** YYYY-MM-DD in the device's local timezone (not UTC). */
const localDateString = (d: Date = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

async function fetchExchangeRate(): Promise<number> {
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) throw new Error(`Exchange rate request failed: ${res.status}`);
  const data = await res.json();
  const cop = data?.rates?.COP;
  if (typeof cop !== "number" || !Number.isFinite(cop)) {
    throw new Error("COP rate missing from response");
  }
  return cop;
}

export default function FinanceWidget() {
  const queryClient = useQueryClient();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<Category>("Food");
  const [selectedCategory, setSelectedCategory] = useState<Filter>("All");

  /* ------------------------- Exchange rate -------------------------- */

  const rateQuery = useQuery({
    queryKey: ["exchange-rate"],
    queryFn: fetchExchangeRate,
    staleTime: 60 * 60 * 1000, // 1 hour
    retry: 1,
    networkMode: "always",
  });

  const rate = rateQuery.data ?? FALLBACK_RATE;
  const rateIsEstimate = rateQuery.data === undefined;

  /* ---------------------------- Expenses ---------------------------- */

  const { data: expenses = [], isLoading } = useQuery({
    queryKey: ["expenses"],
    // Soft-deleted rows stay in Dexie until Supabase confirms; hide them here.
    queryFn: () => db.expenses.filter((e) => !e.deleted).toArray(),
    networkMode: "always",
  });

  const invalidateExpenses = () =>
    queryClient.invalidateQueries({ queryKey: ["expenses"] });

  const addExpense = useMutation({
    networkMode: "always",
    mutationFn: (input: {
      description: string;
      amount: number;
      category: Category;
    }) =>
      db.expenses.add({
        description: input.description,
        amount: input.amount,
        currency: "COP",
        category: input.category,
        expense_date: localDateString(),
        synced: false,
      } as LocalExpense),
    onSuccess: invalidateExpenses,
  });

  const removeExpense = useMutation({
    networkMode: "always",
    mutationFn: (id: NonNullable<LocalExpense["id"]>) =>
      deleteExpenseLocal(id),
    onSuccess: invalidateExpenses,
  });

  /* --------------------------- Derived data ------------------------- */

  const today = localDateString();
  // toArray() returns primary-key order, so reversing gives newest first.
  const todaysExpenses = expenses
    .filter((e) => e.expense_date === today)
    .reverse();

  // The total always covers every category; chips only filter the list.
  const totalToday = todaysExpenses.reduce(
    (sum, e) => sum + (Number(e.amount) || 0),
    0
  );
  const totalTodayUSD = totalToday / rate;

  const visibleExpenses =
    selectedCategory === "All"
      ? todaysExpenses
      : todaysExpenses.filter((e) => e.category === selectedCategory);

  const parsedAmount = Number(amount);
  const canSubmit =
    description.trim().length > 0 &&
    Number.isFinite(parsedAmount) &&
    parsedAmount > 0;

  /* ---------------------------- Handlers ---------------------------- */

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    addExpense.mutate({
      description: description.trim(),
      amount: parsedAmount,
      category,
    });
    setDescription("");
    setAmount("");
  };

  /* ------------------------------ Render ---------------------------- */

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
            <DollarSign className="h-5 w-5" aria-hidden="true" />
          </span>
          <h3 className="text-base font-semibold text-slate-100">Financials</h3>
        </div>

        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium tabular-nums text-emerald-300"
          title={
            rateIsEstimate
              ? "Live rate unavailable, using fallback estimate"
              : "Live exchange rate"
          }
        >
          <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
          {rateIsEstimate && "~"}$1 USD = {numberFmt.format(rate)} COP
        </span>
      </div>

      {/* Today's total */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-900/50 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
          <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
          Today's spend
        </p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-slate-50 transition-all">
          {formatCOP(totalToday)}
        </p>
        <p className="mt-0.5 text-xs tabular-nums text-slate-500">
          ≈ ${totalTodayUSD.toFixed(2)} USD
        </p>
      </div>

      {/* Quick add */}
      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_9rem_8rem_auto]"
      >
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          maxLength={80}
          aria-label="Expense description"
          className="col-span-2 min-w-0 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500/60 focus:outline-none focus:ring-2 focus:ring-sky-500/30 sm:col-span-1"
        />

        <input
          type="number"
          inputMode="numeric"
          min="1"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (COP)"
          aria-label="Amount in COP"
          className="min-w-0 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-sm tabular-nums text-slate-100 placeholder:text-slate-500 transition focus:border-sky-500/60 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
        />

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
          aria-label="Category"
          className="min-w-0 rounded-xl border border-slate-700/60 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200 transition focus:border-sky-500/60 focus:outline-none focus:ring-2 focus:ring-sky-500/30"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={!canSubmit}
          aria-label="Add expense"
          className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-400 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 sm:col-span-1"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span className="sm:hidden">Add expense</span>
        </button>
      </form>

      {/* Category filter chips */}
      <div
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5"
        role="group"
        aria-label="Filter expenses by category"
      >
        {FILTERS.map((f) => {
          const active = selectedCategory === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setSelectedCategory(f)}
              aria-pressed={active}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 active:scale-95 ${
                active
                  ? "border-sky-500/50 bg-sky-500/20 text-sky-200"
                  : "border-slate-700/60 bg-slate-900/40 text-slate-400 hover:border-slate-600 hover:text-slate-200"
              }`}
            >
              {f}
            </button>
          );
        })}
      </div>

      {/* Today's expenses */}
      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-xl bg-slate-700/30"
            />
          ))}
        </div>
      ) : visibleExpenses.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700/60 px-4 py-8 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-700/40 text-slate-400">
            <Receipt className="h-5 w-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-slate-200">
            {selectedCategory === "All"
              ? "No expenses today"
              : `No ${selectedCategory} expenses today`}
          </p>
          <p className="text-xs text-slate-500">
            {selectedCategory === "All"
              ? "Log your first purchase above."
              : "Pick another filter or log a new purchase."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {visibleExpenses.map((expense) => {
            const style =
              CATEGORY_STYLES[expense.category as Category] ??
              CATEGORY_STYLES.General;
            return (
              <li
                key={expense.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/50 bg-slate-900/40 p-3 transition-all duration-200 hover:border-slate-600 hover:bg-slate-900/70"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-700/50 text-slate-300">
                    <Receipt className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {expense.description}
                    </p>
                    <span
                      className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${style}`}
                    >
                      {expense.category}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <p className="text-sm font-semibold tabular-nums text-slate-100">
                    {formatCOP(Number(expense.amount) || 0)}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      removeExpense.mutate(
                        expense.id as NonNullable<LocalExpense["id"]>
                      )
                    }
                    aria-label={`Delete ${expense.description}`}
                    title="Delete"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-rose-500/10 hover:text-rose-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 active:scale-90"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
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