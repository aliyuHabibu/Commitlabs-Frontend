'use client'

import React, { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { AppSidebar } from './AppSidebar'
import {
  APP_SHELL_NAVIGATION_TIMEOUT_MS,
  createIdleAppShellNavigationState,
  readAppShellNavigationState,
  writeAppShellNavigationState,
} from './navigationState'

export interface AppShellLayoutProps {
  children: React.ReactNode
}

export const AppShellLayout: React.FC<AppShellLayoutProps> = ({ children }) => {
  const pathname = usePathname()
  const router = useRouter()
  const [navigationState, setNavigationState] = useState(() => readAppShellNavigationState(pathname || '/'))

  useEffect(() => {
    const state = readAppShellNavigationState(pathname || '/')
    setNavigationState(state)

    if (state.status === 'navigating' && state.startedAt) {
      const elapsed = Date.now() - state.startedAt
      if (elapsed >= APP_SHELL_NAVIGATION_TIMEOUT_MS) {
        const recoveredState = {
          ...state,
          status: 'error' as const,
          message: 'The previous route navigation did not finish cleanly.',
        }
        writeAppShellNavigationState(recoveredState)
        setNavigationState(recoveredState)
      }
    }
  }, [pathname])

  useEffect(() => {
    if (navigationState.status === 'navigating' && navigationState.retryPath === pathname) {
      const nextState = createIdleAppShellNavigationState(pathname || '/')
      writeAppShellNavigationState(nextState)
      setNavigationState(nextState)
    }
  }, [navigationState, pathname])

  const handleRetryNavigation = () => {
    if (!navigationState.retryPath) {
      return
    }

    const nextState = createIdleAppShellNavigationState(pathname || '/')
    writeAppShellNavigationState(nextState)
    setNavigationState(nextState)
    router.refresh()

    if (navigationState.retryPath !== pathname) {
      router.push(navigationState.retryPath)
    }
  }

  const isRecoveryVisible = navigationState.status === 'error' && Boolean(navigationState.retryPath)

  return (
    <div className="flex min-h-screen bg-[#0a0a0a]">
      <AppSidebar />
      <main className="flex-1 md:ml-[240px] transition-[margin] duration-300">
        {isRecoveryVisible && (
          <div
            role="status"
            aria-live="polite"
            className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-50"
          >
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
              <div>
                <p className="font-semibold uppercase tracking-[0.12em] text-amber-200">Navigation recovery</p>
                <p className="text-amber-50/80">
                  {navigationState.message || 'The previous route navigation did not finish cleanly.'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleRetryNavigation}
                className="rounded-lg border border-amber-300/40 bg-amber-500/20 px-3 py-2 font-medium text-amber-50 transition hover:bg-amber-500/25"
              >
                Retry navigation
              </button>
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
