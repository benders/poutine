import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Lightbox } from "./Lightbox";

describe("Lightbox (#200)", () => {
  it("renders the image inside a dialog", () => {
    render(<Lightbox src="/art/full" alt="Cover" onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Cover" })).toHaveAttribute(
      "src",
      "/art/full",
    );
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(<Lightbox src="/art/full" alt="Cover" onClose={onClose} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not close when clicking the image itself", () => {
    const onClose = vi.fn();
    render(<Lightbox src="/art/full" alt="Cover" onClose={onClose} />);
    fireEvent.click(screen.getByRole("img", { name: "Cover" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Lightbox src="/art/full" alt="Cover" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
