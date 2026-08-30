import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AppShellLayout } from './AppShellLayout'

const mockRefresh = vi.fn()
const mockPathname = '/marketplace'

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    refresh: mockRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

describe('AppShellLayout', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    mockRefresh.mockClear()
  })

  afterEach(() => {
    window.sessionStorage.clear()
  })

  it('shows recovery controls when a previous route transition failed', () => {
    window.sessionStorage.setItem(
      'app-shell-navigation-state',
      JSON.stringify({
        status: 'error',
        retryPath: '/create',
        lastPath: '/marketplace',
        message: 'The previous route navigation did not finish cleanly.',
      })
    )

    render(
      <AppShellLayout>
        <div>Protected content</div>
      </AppShellLayout>
    )

    expect(screen.getByText(/navigation recovery/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry navigation/i })).toBeInTheDocument()
  })

  it('keeps the active route state deterministic after a retry', () => {
    window.sessionStorage.setItem(
      'app-shell-navigation-state',
      JSON.stringify({
        status: 'error',
        retryPath: '/create',
        lastPath: '/marketplace',
      })
    )

    render(
      <AppShellLayout>
        <div>Protected content</div>
      </AppShellLayout>
    )

    fireEvent.click(screen.getByRole('button', { name: /retry navigation/i }))

    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem('app-shell-navigation-state')).toContain('"status":"idle"')
  })
})
