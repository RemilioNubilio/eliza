import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWalletRoutes } from "./wallet-routes.js";

describe("wallet-routes config updates", () => {
  const previousEnv = {
    ELIZA_WALLET_NETWORK: process.env.ELIZA_WALLET_NETWORK,
    ETHEREUM_RPC_PROVIDER: process.env.ETHEREUM_RPC_PROVIDER,
    BSC_RPC_PROVIDER: process.env.BSC_RPC_PROVIDER,
    SOLANA_RPC_PROVIDER: process.env.SOLANA_RPC_PROVIDER,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("applies wallet config updates without scheduling a restart", async () => {
    const saveConfig = vi.fn();
    const scheduleRuntimeRestart = vi.fn();
    const clearScheduledRuntimeRestart = vi.fn();
    const json = vi.fn();

    const handled = await handleWalletRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/wallet/config",
      config: {},
      saveConfig,
      ensureWalletKeysInEnvAndConfig: vi.fn(() => true),
      resolveWalletExportRejection: vi.fn(() => null),
      scheduleRuntimeRestart,
      clearScheduledRuntimeRestart,
      readJsonBody: vi.fn(async () => ({
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
        credentials: {},
      })),
      json,
      error: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(saveConfig).toHaveBeenCalledOnce();
    expect(clearScheduledRuntimeRestart).toHaveBeenCalledWith(
      "Wallet configuration updated",
    );
    expect(scheduleRuntimeRestart).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true }),
    );
    expect(
      (
        saveConfig.mock.calls[0]?.[0] as {
          wallet?: {
            rpcProviders?: {
              evm?: string;
              bsc?: string;
              solana?: string;
            };
          };
        }
      ).wallet?.rpcProviders,
    ).toEqual({
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    });
    expect(process.env.ELIZA_WALLET_NETWORK).toBe("mainnet");
  });
});
