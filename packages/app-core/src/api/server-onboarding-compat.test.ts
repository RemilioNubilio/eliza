import { describe, expect, it } from "vitest";
import {
  hasCanonicalOnboardingRequestFields,
  hasLegacyOnboardingRejectFields,
  hasLegacyOnboardingStripFields,
  stripLegacyOnboardingRootKeys,
} from "./server-onboarding-compat";

describe("onboarding compat — legacy vs canonical", () => {
  it("treats walletConfig/connectors/features/sandboxMode as canonical", () => {
    const body = { walletConfig: { selections: {} }, primaryModel: "x" };
    expect(hasCanonicalOnboardingRequestFields(body)).toBe(true);
    expect(hasLegacyOnboardingStripFields(body)).toBe(true);
    expect(hasLegacyOnboardingRejectFields(body)).toBe(false);
    const stripped = stripLegacyOnboardingRootKeys(body);
    expect(stripped).toEqual({ walletConfig: { selections: {} } });
  });

  it("rejects only obsolete v1 markers without any canonical field", () => {
    const body = { connection: "local", runMode: "foo" };
    expect(hasCanonicalOnboardingRequestFields(body)).toBe(false);
    expect(hasLegacyOnboardingRejectFields(body)).toBe(true);
  });

  it("does not reject stray model keys alone without v1 markers or canonical fields", () => {
    const body = { primaryModel: "gpt-4", smallModel: "x" };
    expect(hasCanonicalOnboardingRequestFields(body)).toBe(false);
    expect(hasLegacyOnboardingRejectFields(body)).toBe(false);
    expect(hasLegacyOnboardingStripFields(body)).toBe(true);
  });
});
