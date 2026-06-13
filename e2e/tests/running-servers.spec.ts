import { test, expect } from '../fixtures/tauri'

test.describe('Running Servers @worktree', () => {
  // These tests use the mocked Tauri API. The fixture mocks one worktree
  // (feature-auth) running dev servers on ports 5178 and 8004, and one
  // detached-HEAD worktree (branch SHA "abc1234").

  test('port badges render on the worktree with running servers', async ({ mockedPage }) => {
    // Wait for the list to render.
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    // The feature-auth row carries the running servers.
    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    await expect(featureRow).toBeVisible()

    // Both port badges should render in that row.
    await expect(featureRow.locator('.status-running:has-text(":5178")')).toBeVisible()
    await expect(featureRow.locator('.status-running:has-text(":8004")')).toBeVisible()

    // A worktree without servers should not show any port badge.
    const featureUiRow = mockedPage.locator('.worktree-row:has-text("feature-ui")')
    await expect(featureUiRow.locator('.status-running')).toHaveCount(0)
  })

  test('clicking a port badge does NOT trigger the open-IDE flow', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    const portBadge = featureRow.locator('.status-running:has-text(":5178")')
    await expect(portBadge).toBeVisible()

    // Clicking the badge should open the URL, not bubble up to the row's
    // open-IDE handler (which would show the IDE confirmation modal).
    await portBadge.click()

    // The IDE confirmation modal must NOT appear.
    const ideModal = mockedPage.locator('text=Open in')
    await expect(ideModal).not.toBeVisible()
  })

  test('detached worktree shows the detached label, not a blank cell', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    // The detached row should render the "(detached @ abc1234)" label.
    const detachedLabel = mockedPage.locator('.worktree-branch-detached')
    await expect(detachedLabel).toBeVisible()
    await expect(detachedLabel).toContainText('(detached @ abc1234)')
  })
})
