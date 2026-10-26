import { useCallback, useEffect, useId, useState } from "react";
import { Download } from "lucide-react";

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

/** Not part of TypeScript's DOM lib yet (Chromium-only API). */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt: () => Promise<void>;
}

const DISMISS_KEY = "pwa_install_dismissed";

/* ------------------------------------------------------------------ */
/* localStorage helpers (can throw in private mode or when blocked)    */
/* ------------------------------------------------------------------ */

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    /* storage unavailable: dismissal just won't persist across reloads */
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [installing, setInstalling] = useState(false);
  const [entered, setEntered] = useState(false);
  const titleId = useId();

  /* ---------------- Capture the browser's install event ---------------- */

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      // Stop the browser's own mini-infobar and keep the event for later.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    // Fires after a successful install from any entry point (our button,
    // the address-bar icon, the browser menu).
    const onAppInstalled = () => {
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const visible = deferredPrompt !== null && !dismissed;

  /* Slide/fade in after mount so the transition actually plays. */
  useEffect(() => {
    if (!visible) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [visible]);

  /* ----------------------------- Handlers ----------------------------- */

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt || installing) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch (err) {
      console.warn("[InstallPrompt] install prompt failed", err);
    } finally {
      // The event can only be used once, whatever the outcome.
      setDeferredPrompt(null);
      setInstalling(false);
    }
  }, [deferredPrompt, installing]);

  const handleDismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  if (!visible) return null;

  /* ------------------------------ Render ------------------------------ */

  return (
    <div className="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 md:inset-x-auto md:bottom-6 md:left-1/2 md:w-full md:max-w-md md:-translate-x-1/2">
      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        className={`rounded-2xl border border-slate-700 bg-slate-800 p-4 shadow-2xl transition-all duration-300 ease-out motion-reduce:transition-none ${
          entered ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
        }`}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-400">
            <Download className="h-5 w-5" aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="text-sm font-semibold text-slate-100"
            >
              Install Personal Dashboard
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Add to Home Screen for native offline access.
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            className="rounded-xl px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:bg-slate-700/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-95"
          >
            Dismiss
          </button>

          <button
            type="button"
            onClick={() => void handleInstall()}
            disabled={installing}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-70"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Install
          </button>
        </div>
      </div>
    </div>
  );
}