let authHydrated = false;
let directAuthHydrated = false;
let resolveAuthHydration: (() => void) | null = null;

const authHydrationPromise = new Promise<void>((resolve) => {
  resolveAuthHydration = resolve;
});

function maybeResolveAuthHydration() {
  if (!authHydrated || !directAuthHydrated) return;
  resolveAuthHydration?.();
  resolveAuthHydration = null;
}

export function markAuthHydrated() {
  if (authHydrated) return;
  authHydrated = true;
  maybeResolveAuthHydration();
}

export function markDirectAuthHydrated() {
  if (directAuthHydrated) return;
  directAuthHydrated = true;
  maybeResolveAuthHydration();
}

export function hasAuthHydrated() {
  return authHydrated;
}

export async function waitForAuthHydration() {
  if (authHydrated && directAuthHydrated) return;
  await authHydrationPromise;
}
