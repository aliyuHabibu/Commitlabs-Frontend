export type AppShellNavigationStatus = 'idle' | 'navigating' | 'error';

export interface AppShellNavigationState {
  status: AppShellNavigationStatus;
  lastPath: string;
  retryPath: string | null;
  attemptId: string | null;
  startedAt: number | null;
  message: string | null;
}

export const APP_SHELL_NAVIGATION_STORAGE_KEY = 'app-shell-navigation-state';
export const APP_SHELL_NAVIGATION_TIMEOUT_MS = 15000;

export function createIdleAppShellNavigationState(path = '/'): AppShellNavigationState {
  return {
    status: 'idle',
    lastPath: path,
    retryPath: null,
    attemptId: null,
    startedAt: null,
    message: null,
  };
}

export function readAppShellNavigationState(fallbackPath = '/'): AppShellNavigationState {
  if (typeof window === 'undefined' || !('sessionStorage' in window)) {
    return createIdleAppShellNavigationState(fallbackPath);
  }

  try {
    const raw = window.sessionStorage.getItem(APP_SHELL_NAVIGATION_STORAGE_KEY);
    if (!raw) {
      return createIdleAppShellNavigationState(fallbackPath);
    }

    const parsed = JSON.parse(raw) as Partial<AppShellNavigationState>;
    return {
      ...createIdleAppShellNavigationState(fallbackPath),
      ...parsed,
      lastPath: parsed.lastPath || fallbackPath,
      retryPath: parsed.retryPath || null,
      attemptId: parsed.attemptId || null,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
      message: parsed.message || null,
    };
  } catch {
    return createIdleAppShellNavigationState(fallbackPath);
  }
}

export function writeAppShellNavigationState(state: AppShellNavigationState): void {
  if (typeof window === 'undefined' || !('sessionStorage' in window)) {
    return;
  }

  try {
    window.sessionStorage.setItem(APP_SHELL_NAVIGATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or browser privacy failures. The UI remains functional.
  }
}

export function isDuplicateNavigationAttempt(
  state: AppShellNavigationState,
  targetPath: string,
): boolean {
  return state.status === 'navigating' && state.retryPath === targetPath;
}
