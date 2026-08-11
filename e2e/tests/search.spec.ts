import { test, expect } from '../fixtures/tauri'

// Search was previously reachable only via ⌘F (or by typing), with nothing in
// the UI to advertise it. These cover the titlebar button that exposes it.
test.describe('Search @worktree', () => {
  const searchButton = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: 'Search worktrees' })

  test('the titlebar search button opens the search bar and focuses it', async ({
    mockedPage,
  }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })

    // Hidden until asked for.
    await expect(mockedPage.locator('.search-bar')).toHaveCount(0)

    await searchButton(mockedPage).click()

    const input = mockedPage.locator('.search-bar-input')
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await expect(searchButton(mockedPage)).toHaveAttribute('aria-pressed', 'true')
  })

  test('typing in the search bar filters the worktree list', async ({ mockedPage }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })
    const rowsBefore = await mockedPage.locator('.worktree-row').count()
    expect(rowsBefore).toBeGreaterThan(1)

    await searchButton(mockedPage).click()
    await mockedPage.locator('.search-bar-input').fill('feature-auth')

    const rows = mockedPage.locator('.worktree-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('feature-auth')
  })

  test('clicking the button again closes search and restores the full list', async ({
    mockedPage,
  }) => {
    await mockedPage.locator('.worktree-row').first().waitFor({ timeout: 10000 })
    const rowsBefore = await mockedPage.locator('.worktree-row').count()

    await searchButton(mockedPage).click()
    await mockedPage.locator('.search-bar-input').fill('feature-auth')
    await expect(mockedPage.locator('.worktree-row')).toHaveCount(1)

    // Toggling off must also drop the query — otherwise the list would stay
    // filtered with no visible search bar explaining why.
    await searchButton(mockedPage).click()

    await expect(mockedPage.locator('.search-bar')).toHaveCount(0)
    await expect(mockedPage.locator('.worktree-row')).toHaveCount(rowsBefore)
  })
})
