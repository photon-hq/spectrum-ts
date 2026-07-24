import { cloud, type ProjectData } from "@spectrum-ts/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProfileSyncGate,
  disposeProfileSyncGate,
  getProfileSyncGate,
  registerProfileSyncGate,
} from "@/remote/profile-sync-gate";
import type { IMessageClient } from "@/types";

const projectConfig = (imessageSynced: boolean): ProjectData => ({
  id: "project-1",
  name: "Profile Gate Test",
  profile: { imessageSynced },
  slug: "profile-gate-test",
});

describe("iMessage profile sync gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses the initialization value until its cache expires", async () => {
    const refresh = vi.fn(() => Promise.resolve(true));
    const gate = createProfileSyncGate({
      cacheTtlMs: 60_000,
      initialEnabled: false,
      refresh,
    });

    expect(await gate.isEnabled()).toBe(false);
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(59_999);
    expect(await gate.isEnabled()).toBe(false);
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(60_000);
    expect(await gate.isEnabled()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("disables sharing when a refreshed aggregate turns false", async () => {
    const refresh = vi.fn(() => Promise.resolve(false));
    const gate = createProfileSyncGate({
      cacheTtlMs: 60_000,
      initialEnabled: true,
      refresh,
    });

    expect(await gate.isEnabled()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(60_000);
    expect(await gate.isEnabled()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refreshes", async () => {
    let resolveRefresh: ((value: boolean) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const gate = createProfileSyncGate({
      cacheTtlMs: 0,
      initialEnabled: false,
      refresh,
    });

    const first = gate.isEnabled();
    const second = gate.isEnabled();
    expect(refresh).toHaveBeenCalledTimes(1);

    resolveRefresh?.(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("fails closed and backs off before retrying", async () => {
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("cloud unavailable"))
      .mockResolvedValueOnce(true);
    const gate = createProfileSyncGate({
      cacheTtlMs: 0,
      initialEnabled: true,
      refresh,
      retryDelayMs: 30_000,
    });

    expect(await gate.isEnabled()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(29_999);
    expect(await gate.isEnabled()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(30_000);
    expect(await gate.isEnabled()).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes the project aggregate with the original credentials", async () => {
    const getProject = vi
      .spyOn(cloud, "getProject")
      .mockResolvedValue(projectConfig(true));
    const clients = [] as IMessageClient;

    registerProfileSyncGate(
      clients,
      "project-1",
      "project-secret",
      projectConfig(false)
    );
    const gate = getProfileSyncGate(clients);
    expect(gate).toBeDefined();
    expect(await gate?.isEnabled()).toBe(false);
    expect(getProject).not.toHaveBeenCalled();

    vi.setSystemTime(60_000);
    expect(await gate?.isEnabled()).toBe(true);
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(getProject).toHaveBeenCalledWith("project-1", "project-secret");

    disposeProfileSyncGate(clients);
    expect(getProfileSyncGate(clients)).toBeUndefined();
    expect(await gate?.isEnabled()).toBe(false);
  });
});
