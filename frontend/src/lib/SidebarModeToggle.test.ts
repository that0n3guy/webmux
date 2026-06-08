import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import SidebarModeToggle from "./SidebarModeToggle.svelte";

describe("SidebarModeToggle", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders both pills", () => {
    render(SidebarModeToggle, { props: { mode: "projects", onchange: vi.fn() } });
    expect(screen.getByRole("button", { name: "Projects view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Active view" })).toBeInTheDocument();
  });

  it("marks the current mode pill as pressed", () => {
    render(SidebarModeToggle, { props: { mode: "active", onchange: vi.fn() } });
    expect(screen.getByRole("button", { name: "Active view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Projects view" })).toHaveAttribute("aria-pressed", "false");
  });

  it("fires onchange with 'active' when Projects is active and Active is clicked", async () => {
    const onchange = vi.fn();
    render(SidebarModeToggle, { props: { mode: "projects", onchange } });
    await fireEvent.click(screen.getByRole("button", { name: "Active view" }));
    expect(onchange).toHaveBeenCalledWith("active");
  });

  it("fires onchange with 'projects' when Active is active and Projects is clicked", async () => {
    const onchange = vi.fn();
    render(SidebarModeToggle, { props: { mode: "active", onchange } });
    await fireEvent.click(screen.getByRole("button", { name: "Projects view" }));
    expect(onchange).toHaveBeenCalledWith("projects");
  });

  it("does not fire onchange when the already-active pill is clicked", async () => {
    const onchange = vi.fn();
    render(SidebarModeToggle, { props: { mode: "projects", onchange } });
    await fireEvent.click(screen.getByRole("button", { name: "Projects view" }));
    expect(onchange).not.toHaveBeenCalled();
  });
});
