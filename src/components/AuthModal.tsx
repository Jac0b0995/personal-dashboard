import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { runFullSync } from "../lib/syncEngine";
import { adoptUser } from "../lib/auth";

type Mode = "signin" | "signup";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

const MIN_PASSWORD = 6; // Supabase's default minimum

/** Turns Supabase / fetch errors into short, human messages. */
function friendlyError(error: {
  message?: string;
  name?: string;
  status?: number;
}): string {
  const msg = (error.message ?? "").toLowerCase();

  if (
    (typeof navigator !== "undefined" && !navigator.onLine) ||
    error.name === "AuthRetryableFetchError" ||
    msg.includes("failed to fetch") ||
    msg.includes("network")
  ) {
    return "Network error. Check your connection and try again.";
  }
  if (msg.includes("invalid login credentials"))
    return "Incorrect email or password.";
  if (msg.includes("already registered"))
    return "An account with this email already exists. Try signing in.";
  if (msg.includes("email not confirmed"))
    return "Confirm your email first. Check your inbox for the link.";
  if (msg.includes("password should be"))
    return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (error.status === 429 || msg.includes("rate limit"))
    return "Too many attempts. Wait a minute and try again.";
  if (msg.includes("invalid") && msg.includes("email"))
    return "Enter a valid email address.";

  return error.message || "Something went wrong. Please try again.";
}

export default function AuthModal({ open, onClose }: AuthModalProps) {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);

  /* Reset the form and focus the first field each time the modal opens. */
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setShowPassword(false);
    setError(null);
    setNotice(null);
    const id = requestAnimationFrame(() => emailRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  /* Escape closes; background scroll is locked while open. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, busy, onClose]);

  if (!open) return null;

  const switchMode = (next: Mode) => {
    if (busy) return;
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    void queryClient.invalidateQueries({ queryKey: ["expenses"] });
  };

  /** Shared success path: adopt the user, close, then sync in the background. */
  const finishSignIn = async (userId: string) => {
    const switchedUser = await adoptUser(userId);
    if (switchedUser) refreshLists(); // previous user's rows were wiped
    onClose();
    void runFullSync().then(refreshLists);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setError("Enter your email address.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === "signin") {
        const { data, error: authError } =
          await supabase.auth.signInWithPassword({
            email: cleanEmail,
            password,
          });
        if (authError || !data.user) {
          setError(
            friendlyError(authError ?? { message: "Sign in failed." })
          );
          return;
        }
        await finishSignIn(data.user.id);
      } else {
        const { data, error: authError } = await supabase.auth.signUp({
          email: cleanEmail,
          password,
        });
        if (authError) {
          setError(friendlyError(authError));
          return;
        }
        // With email confirmation on, an existing address returns a fake
        // user with no identities instead of an error.
        if (data.user && data.user.identities?.length === 0) {
          setError("An account with this email already exists. Try signing in.");
          return;
        }
        if (!data.session || !data.user) {
          // Email confirmation is required: no session until the link is clicked.
          setNotice("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
          setPassword("");
          return;
        }
        await finishSignIn(data.user.id);
      }
    } catch (err) {
      setError(friendlyError(err as Error));
    } finally {
      setBusy(false);
    }
  };

  const isSignUp = mode === "signup";
  const inputClasses =
    "w-full rounded-xl border border-slate-700 bg-slate-800 p-3 text-white placeholder:text-slate-500 transition focus:border-indigo-500/70 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/90 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        className="relative w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <h2 id="auth-title" className="text-lg font-semibold text-white">
          {isSignUp ? "Create your account" : "Welcome back"}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {isSignUp
            ? "Sign up to back up and sync your dashboard."
            : "Sign in to sync your tasks and expenses."}
        </p>

        {/* Mode toggle */}
        <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-slate-700 bg-slate-800/60 p-1">
          {(["signin", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              aria-pressed={mode === m}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                mode === m
                  ? "bg-indigo-500/25 text-indigo-200"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m === "signin" ? "Sign In" : "Sign Up"}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3" noValidate>
          <div className="relative">
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              ref={emailRef}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              aria-label="Email"
              disabled={busy}
              className={`${inputClasses} pl-10`}
            />
          </div>

          <div className="relative">
            <Lock
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type={showPassword ? "text" : "password"}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-label="Password"
              disabled={busy}
              className={`${inputClasses} pl-10 pr-11`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300"
            >
              <AlertCircle
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {error}
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-purple-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:from-indigo-400 hover:to-purple-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            )}
            {busy
              ? isSignUp
                ? "Creating account…"
                : "Signing in…"
              : isSignUp
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="mt-4 w-full text-center text-xs text-slate-500 transition hover:text-slate-300 disabled:opacity-50"
        >
          Continue offline without an account
        </button>
      </div>
    </div>
  );
}