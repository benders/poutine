import { renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { createElement } from "react";

import { useScrollRestoration } from "./useScrollRestoration";

function withMain() {
  document.body.innerHTML = "<main></main>";
  const main = document.querySelector("main")!;
  Object.defineProperty(main, "scrollTop", {
    configurable: true,
    get() {
      return Number((main as HTMLElement).dataset.scroll ?? 0);
    },
    set(v: number) {
      (main as HTMLElement).dataset.scroll = String(v);
    },
  });
  return main as HTMLElement;
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(MemoryRouter, null, children);

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
});

describe("useScrollRestoration", () => {
  it("restores scrollTop once ready is true", () => {
    const main = withMain();
    sessionStorage.setItem("scroll:albums", "777");

    const { rerender } = renderHook(
      ({ ready }) => useScrollRestoration("albums", ready),
      { wrapper, initialProps: { ready: false } },
    );
    expect(main.scrollTop).toBe(0);

    rerender({ ready: true });
    expect(main.scrollTop).toBe(777);
  });

  it("does nothing when no value is stored", () => {
    const main = withMain();
    renderHook(() => useScrollRestoration("albums", true), { wrapper });
    expect(main.scrollTop).toBe(0);
  });

  it("does not overwrite stored value on unmount", () => {
    const main = withMain();
    sessionStorage.setItem("scroll:albums", "500");
    const { unmount } = renderHook(() => useScrollRestoration("albums", true), { wrapper });
    main.scrollTop = 0;
    unmount();
    expect(sessionStorage.getItem("scroll:albums")).toBe("500");
  });
});
