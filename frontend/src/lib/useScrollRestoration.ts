import { useEffect, useRef } from "react";

const PREFIX = "scroll:";

function getContainer(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector("main");
}

export function useScrollRestoration(key: string, ready: boolean) {
  const restored = useRef(false);

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

  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const container = getContainer();
    if (!container) return;
    const saved = sessionStorage.getItem(PREFIX + key);
    if (saved === null) return;
    const top = Number(saved);
    if (!Number.isFinite(top)) return;
    container.scrollTop = top;
  }, [key, ready]);
}
