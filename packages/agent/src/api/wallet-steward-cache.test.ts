import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStewardWalletAddressesToRuntimeCache,
  getWalletAddresses,
  STEWARD_EVM_ADDRESS_ENV_KEY,
  STEWARD_SOLANA_ADDRESS_ENV_KEY,
} from "./wallet.js";

describe("applyStewardWalletAddressesToRuntimeCache", () => {
  const envKeys = [
    STEWARD_EVM_ADDRESS_ENV_KEY,
    STEWARD_SOLANA_ADDRESS_ENV_KEY,
    "SOLANA_PUBLIC_KEY",
    "WALLET_PUBLIC_KEY",
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
  ] as const;

  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      snapshot[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
    applyStewardWalletAddressesToRuntimeCache(null, null);
  });

  it("updates process env and getWalletAddresses without a server restart", () => {
    delete process.env.EVM_PRIVATE_KEY;
    delete process.env.SOLANA_PRIVATE_KEY;

    const evm = "0x0000000000000000000000000000000000000001";
    applyStewardWalletAddressesToRuntimeCache(evm, null);

    expect(process.env[STEWARD_EVM_ADDRESS_ENV_KEY]).toBe(evm);
    const a = getWalletAddresses();
    expect(a.evmAddress).toBe(evm);
  });
});
