import { describe, expect, it } from "vitest";
import { shouldReuseExistingCloudSession } from "./cloud-session";

describe("shouldReuseExistingCloudSession", () => {
  it("reuses the local cloud session when app state is already connected", () => {
    expect(
      shouldReuseExistingCloudSession({
        localConnected: true,
        statusSnapshot: null,
      }),
    ).toBe(true);
  });

  it("reuses the backend cloud session when the status snapshot is connected", () => {
    expect(
      shouldReuseExistingCloudSession({
        localConnected: false,
        statusSnapshot: { connected: true },
      }),
    ).toBe(true);
  });

  it("starts login only when neither local nor backend state is connected", () => {
    expect(
      shouldReuseExistingCloudSession({
        localConnected: false,
        statusSnapshot: { connected: false },
      }),
    ).toBe(false);
  });
});
