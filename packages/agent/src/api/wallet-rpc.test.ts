import { describe, expect, it } from "vitest";
import {
  resolveEthereumRpcUrls,
  resolveWalletRpcReadiness,
} from "./wallet-rpc.js";

describe("wallet-rpc", () => {
  it("merges public EVM fallbacks when eliza-cloud is selected but no cloud API key", () => {
    const readiness = resolveWalletRpcReadiness({
      cloud: {},
      wallet: {
        rpcProviders: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
      },
    } as Parameters<typeof resolveWalletRpcReadiness>[0]);

    expect(readiness.cloudManagedAccess).toBe(false);
    expect(readiness.ethereumRpcUrls.length).toBeGreaterThan(0);
    expect(readiness.baseRpcUrls.length).toBeGreaterThan(0);
    expect(readiness.evmBalanceReady).toBe(true);
    expect(readiness.solanaBalanceReady).toBe(true);
  });

  it("resolveEthereumRpcUrls includes public URLs when includePublicRpcFallbacks is set", () => {
    const urls = resolveEthereumRpcUrls({
      cloudManagedAccess: false,
      includePublicRpcFallbacks: true,
    });
    expect(urls.some((u) => u.includes("publicnode.com"))).toBe(true);
  });
});
