import { useEffect, useRef } from "react";

const PREFIX = "scroll:";

function getContainer(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector("main");
}

export function useScrollRestoration(key: string, ready: boolean) {
  const restoredKey = useRef<string | null>(null);

  useEffect(() => {
    const container = getContainer();
    if (!container) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sessionStorage.setItem(PREFIX + key, String(container.scrollTop));
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [key]);

  // Restore once per key. When `key` changes (e.g. switching between Albums
  // sub-views), restore for the new key on next ready.
  useEffect(() => {
    if (!ready || restoredKey.current === key) return;
    restoredKey.current = key;
    const container = getContainer();
    if (!container) return;
    const saved = sessionStorage.getItem(PREFIX + key);
    const top = saved === null ? 0 : Number(saved);
    container.scrollTop = Number.isFinite(top) ? top : 0;
  }, [key, ready]);
}
