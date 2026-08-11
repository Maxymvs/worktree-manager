import { test, expect } from '../fixtures/tauri'

// Confirming a delete returns the user to the list immediately; the removal
// runs in the background and reports progress on the row itself. The fixture's
// `remove_worktree` mock is deliberately slow so that window is observable.
test.describe('Inline worktree deletion @worktree', () => {
  /** Open the delete dialog for the feature-auth worktree. */
  async function openDeleteDialog(page: import('@playwright/test').Page) {
    await page.locator('.worktree-row').first().waitFor({ timeout: 10000 })
    const row = page.locator('.worktree-row:has-text("feature-auth")')
    await row.locator('.worktree-more').click()
    await page.locator('.worktree-actions-dropdown-portal').waitFor()
    await page.locator('.worktree-dropdown-item-danger:has-text("Delete")').click()
    await expect(page.getByRole('button', { name: /^Delete/ })).toBeVisible()
    return row
  }

  test('confirming closes the dialog immediately instead of blocking', async ({ mockedPage }) => {
    await openDeleteDialog(mockedPage)

    const dialogTitle = mockedPage.getByRole('heading', { name: 'Delete Worktree' })
    await expect(dialogTitle).toBeVisible()

    await mockedPage.getByRole('button', { name: /^Delete/ }).click()

    // The dialog is gone well before the 1500ms removal finishes.
    await expect(dialogTitle).not.toBeVisible({ timeout: 1000 })
  })

  test('the row shows an inline deleting badge while removal runs', async ({ mockedPage }) => {
    const row = await openDeleteDialog(mockedPage)
    await mockedPage.getByRole('button', { name: /^Delete/ }).click()

    const badge = row.getByTestId('deleting-badge')
    await expect(badge).toBeVisible({ timeout: 1000 })
    await expect(badge).toContainText('Deleting')

    // The row is marked busy and its actions are withdrawn while it drains.
    await expect(row).toHaveAttribute('aria-busy', 'true')
    await expect(row.locator('.worktree-more')).toHaveCount(0)
  })

  test('the port pill is replaced by the deleting badge', async ({ mockedPage }) => {
    const row = await openDeleteDialog(mockedPage)

    // feature-auth has a running server, so it shows a port pill up front.
    await expect(row.locator('.server-pill')).toBeVisible()

    await mockedPage.getByRole('button', { name: /^Delete/ }).click()

    await expect(row.getByTestId('deleting-badge')).toBeVisible({ timeout: 1000 })
    await expect(row.locator('.server-pill')).toHaveCount(0)
  })
})
