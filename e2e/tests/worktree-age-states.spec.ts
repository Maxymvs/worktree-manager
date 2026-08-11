import { test, expect } from '../fixtures/tauri'

test.describe('Worktree Age & State Badges @worktree', () => {
  // The fixture mocks 5 worktrees, each with a `created_at_ms` a fixed number
  // of days in the past, one detached-HEAD entry ("abc1234") and one prunable
  // entry ("old-feature"). Only feature-auth has running servers, so it is the
  // row whose port-pill hover card carries the creation time.

  test('server pill hover card shows when the worktree was created', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    await featureRow.locator('.server-pill').hover()

    // Radix portals the hover card to the body; feature-auth is mocked 3 days old.
    const created = mockedPage.getByTestId('worktree-age')
    await expect(created).toBeVisible({ timeout: 5000 })
    await expect(created).toContainText('Worktree created 3 days ago')
    // The absolute date follows the relative one ("· Jul 28, 2026 at 2:41 PM").
    await expect(created).toContainText('·')
  })

  test('main worktree labels its date as a clone, not a worktree creation', async ({
    mockedPage,
  }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    // The main worktree is the clone itself, so "Worktree created" would be
    // wrong there — its birthtime is when the repo was cloned.
    const mainRow = mockedPage.locator('.worktree-row:has-text("main")').first()
    await mainRow.locator('.server-pill').hover()

    const created = mockedPage.getByTestId('worktree-age')
    await expect(created).toBeVisible({ timeout: 5000 })
    await expect(created).toContainText('Repo cloned')
    await expect(created).not.toContainText('Worktree created')
  })

  test('detached worktree shows a "no branch" badge with an explanatory tooltip', async ({
    mockedPage,
  }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const badge = mockedPage.getByTestId('detached-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('no branch')

    // The old "(detached @ …)" phrasing is gone; only the bare SHA remains.
    await expect(mockedPage.locator('.worktree-branch-detached')).toHaveText('abc1234')
    await expect(mockedPage.locator('text=(detached @')).toHaveCount(0)

    await badge.hover()

    const tooltip = mockedPage.locator('.tooltip-content', { hasText: 'Detached HEAD' })
    await expect(tooltip.first()).toBeVisible({ timeout: 5000 })
    await expect(tooltip.first()).toContainText('abc1234')
  })

  test('prunable worktree shows a "stale" badge with an explanatory tooltip', async ({
    mockedPage,
  }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const badge = mockedPage.getByTestId('stale-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('stale')

    // The raw git term is no longer surfaced as the badge label.
    await expect(mockedPage.locator('.worktree-prunable-badge')).not.toHaveText('prunable')

    await badge.hover()

    const tooltip = mockedPage.locator('.tooltip-content', { hasText: 'Git can no longer find' })
    await expect(tooltip.first()).toBeVisible({ timeout: 5000 })
    await expect(tooltip.first()).toContainText('safe to remove')
  })
})
