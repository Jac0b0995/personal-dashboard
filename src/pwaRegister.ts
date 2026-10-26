import { registerSW } from "virtual:pwa-register";

/** How often a long-lived tab checks for a new service worker. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let registered = false;

/**
 * Registers the service worker, checks for updates hourly, and applies a
 * waiting update when it can't interrupt the user.
 * Safe to call more than once: only the first call registers.
 */
export function registerPwaServiceWorker(): void {
  if (registered || typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  registered = true;

  let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;
  let updateWaiting = false;

  /** Activates the waiting worker and reloads (the reload happens inside updateSW). */
  const activateUpdate = () => {
    if (!updateWaiting || !applyUpdate) return;
    updateWaiting = false;
    void applyUpdate(true);
  };

  // Reloading while the user is typing a task or expense would lose their input,
  // so a waiting update is applied when the tab is next hidden.
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") activateUpdate();
  };

  applyUpdate = registerSW({
    immediate: true,

    onRegisteredSW(swUrl, registration) {
      if (!registration) return;

      window.setInterval(async () => {
        // Skip while a worker is already installing, or while offline.
        if (registration.installing || !navigator.onLine) return;

        try {
          // Confirm the server is reachable and the script isn't served from
          // the HTTP cache before asking the browser to run its update check.
          const res = await fetch(swUrl, {
            cache: "no-store",
            headers: { "cache-control": "no-cache" },
          });
          if (res.status === 200) await registration.update();
        } catch {
          // Network dropped mid-check: try again next interval.
        }
      }, UPDATE_CHECK_INTERVAL_MS);
    },

    onNeedRefresh() {
      updateWaiting = true;
      console.info("[pwa] New version ready. It will apply when the tab is hidden.");
      // If the tab is already in the background, apply it right away.
      if (document.visibilityState === "hidden") activateUpdate();
    },

    onOfflineReady() {
      console.info("[pwa] App is cached and ready to work offline.");
    },

    onRegisterError(error) {
      console.error("[pwa] Service worker registration failed:", error);
    },
  });

  document.addEventListener("visibilitychange", onVisibilityChange);
}