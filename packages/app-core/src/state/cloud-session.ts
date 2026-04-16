export function shouldReuseExistingCloudSession(args: {
  localConnected: boolean;
  statusSnapshot: { connected?: boolean | null } | null;
}): boolean {
  return args.localConnected || Boolean(args.statusSnapshot?.connected);
}
