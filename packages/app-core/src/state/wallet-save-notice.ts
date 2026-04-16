import type { WalletAddresses, WalletConfigUpdateRequest } from "../api";

export function resolveWalletRpcSaveNotice(args: {
  config: WalletConfigUpdateRequest;
  walletAddresses: WalletAddresses | null;
}): string {
  const enabledCloudRpc = Object.values(args.config.selections ?? {}).some(
    (provider) => provider === "eliza-cloud",
  );
  const hasWalletAddress = Boolean(
    args.walletAddresses?.evmAddress || args.walletAddresses?.solanaAddress,
  );

  if (enabledCloudRpc && !hasWalletAddress) {
    return "Eliza Cloud RPC is ready. Add or import wallet keys in Wallet & RPC to start trading.";
  }

  return "Wallet RPC settings saved.";
}
