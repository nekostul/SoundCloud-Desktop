let authHydrated = false;
let resolveAuthHydration: (() => void) | null = null;

const authHydrationPromise = new Promise<void>((resolve) => {
  resolveAuthHydration = resolve;
});

export function markAuthHydrated() {
  if (authHydrated) return;
  authHydrated = true;
  resolveAuthHydration?.();
  resolveAuthHydration = null;
}

export function hasAuthHydrated() {
  return authHydrated;
}

export async function waitForAuthHydration() {
  if (authHydrated) return;
  await authHydrationPromise;
}
