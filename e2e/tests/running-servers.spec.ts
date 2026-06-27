import { test, expect } from '../fixtures/tauri'

test.describe('Running Servers @worktree', () => {
  // These tests use the mocked Tauri API. The fixture mocks one worktree
  // (feature-auth) running dev servers on ports 5178 and 8004, and one
  // detached-HEAD worktree (branch SHA "abc1234"). The UI collapses the
  // servers into a single primary pill (lowest port = :5178) with an
  // interactive hover dropdown listing all servers.

  test('primary server pill renders on the worktree with running servers', async ({ mockedPage }) => {
    // Wait for the list to render.
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    // The feature-auth row carries the running servers.
    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    await expect(featureRow).toBeVisible()

    // Exactly one running pill renders, showing the primary (lowest) port.
    const pills = featureRow.locator('.status-running')
    await expect(pills).toHaveCount(1)
    await expect(pills).toContainText(':5178')

    // The secondary port lives in the portaled hover dropdown and is hidden
    // until hover, so it must not be visible initially.
    await expect(mockedPage.locator('.status-running:has-text(":8004")')).not.toBeVisible()

    // A worktree without servers should not show any port pill.
    const featureUiRow = mockedPage.locator('.worktree-row:has-text("feature-ui")')
    await expect(featureUiRow.locator('.status-running')).toHaveCount(0)
  })

  test('clicking the primary pill does NOT trigger the open-IDE flow', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    const portPill = featureRow.locator('.status-running:has-text(":5178")')
    await expect(portPill).toBeVisible()

    // Clicking the pill should open the URL, not bubble up to the row's
    // open-IDE handler (which would show the IDE confirmation modal).
    await portPill.click()

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

  test('hovering the primary pill reveals a dropdown listing all servers', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    const featureRow = mockedPage.locator('.worktree-row:has-text("feature-auth")')
    const portPill = featureRow.locator('.status-running:has-text(":5178")')
    await expect(portPill).toBeVisible()

    await portPill.hover()

    // The Radix hover card is portaled to the body; assert it becomes visible
    // and lists BOTH servers plus the footer hint. Generous timeout absorbs
    // the open delay without a fixed wait.
    const card = mockedPage.locator('.server-hover-card')
    await expect(card).toBeVisible({ timeout: 5000 })
    await expect(card).toContainText(':5178')
    await expect(card).toContainText(':8004')
    await expect(card).toContainText('Click to open in browser')
  })
})
