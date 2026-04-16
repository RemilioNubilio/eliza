import { describe, expect, it } from "vitest";
import { resolveWalletRpcSaveNotice } from "./wallet-save-notice";

describe("resolveWalletRpcSaveNotice", () => {
  it("explains that managed RPC is ready when cloud mode is enabled without a wallet", () => {
    expect(
      resolveWalletRpcSaveNotice({
        config: {
          selections: {
            evm: "eliza-cloud",
            bsc: "eliza-cloud",
            solana: "eliza-cloud",
          },
        },
        walletAddresses: null,
      }),
    ).toBe(
      "Eliza Cloud RPC is ready. Add or import wallet keys in Wallet & RPC to start trading.",
    );
  });

  it("keeps the generic success copy once a wallet is already connected", () => {
    expect(
      resolveWalletRpcSaveNotice({
        config: {
          selections: {
            evm: "eliza-cloud",
            bsc: "eliza-cloud",
            solana: "eliza-cloud",
          },
        },
        walletAddresses: {
          evmAddress: "0x123",
          solanaAddress: null,
        },
      }),
    ).toBe("Wallet RPC settings saved.");
  });
});
