import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorMessage, formatError } from "./ErrorMessage";
import { SubsonicError } from "@/lib/subsonic";

describe("formatError", () => {
  it("extracts Subsonic code + message", () => {
    const r = formatError(new SubsonicError("Required parameter missing", 10));
    expect(r).toEqual({ title: "Required parameter missing", code: 10 });
  });

  it("handles plain Error", () => {
    expect(formatError(new Error("boom"))).toEqual({ title: "boom" });
  });

  it("handles unknown throw values", () => {
    expect(formatError("oops")).toEqual({ title: "Unknown error" });
  });
});

describe("<ErrorMessage />", () => {
  it("shows Subsonic code and message", () => {
    render(<ErrorMessage error={new SubsonicError("Bad id", 70)} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Bad id")).toBeInTheDocument();
    expect(screen.getByText(/code 70/)).toBeInTheDocument();
  });

  it("omits code line when code is 0", () => {
    render(<ErrorMessage error={new Error("nope")} />);
    expect(screen.getByText("nope")).toBeInTheDocument();
    expect(screen.queryByText(/code/i)).toBeNull();
  });
});
