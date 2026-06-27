import { test, expect } from '../fixtures/tauri'

test.describe('Worktree Comments @worktree @critical', () => {
  // Uses the mocked Tauri API; the memo store is stateful within a page session.

  const featureRowSelector = '.worktree-row:has-text("feature-auth")'

  test('action menu offers "Add comment"', async ({ mockedPage }) => {
    const featureRow = mockedPage.locator(featureRowSelector)
    await expect(featureRow).toBeVisible({ timeout: 10000 })

    await featureRow.locator('.worktree-more').click()
    await mockedPage.locator('.worktree-actions-dropdown-portal').waitFor()

    const addComment = mockedPage.locator('.worktree-dropdown-item:has-text("Add comment")')
    await expect(addComment).toBeVisible()
  })

  test('adding a comment shows it on the worktree row', async ({ mockedPage }) => {
    const note = 'still in progress of working on'

    const featureRow = mockedPage.locator(featureRowSelector)
    await expect(featureRow).toBeVisible({ timeout: 10000 })

    // Open the comment modal from the more menu.
    await featureRow.locator('.worktree-more').click()
    await mockedPage.locator('.worktree-dropdown-item:has-text("Add comment")').click()

    // Modal is scoped to the feature-auth worktree.
    await expect(mockedPage.getByText('Note for feature-auth')).toBeVisible()

    // Type the note and save.
    const textarea = mockedPage.locator('.modal-textarea')
    await textarea.fill(note)
    await mockedPage.getByRole('button', { name: 'Save' }).click()

    // The note appears as an inline line under the feature-auth row...
    const comment = featureRow.locator('.worktree-comment-text')
    await expect(comment).toHaveText(note)

    // ...and the menu now offers editing instead of adding.
    await featureRow.locator('.worktree-more').click()
    await expect(
      mockedPage.locator('.worktree-dropdown-item:has-text("Edit comment")')
    ).toBeVisible()
  })

  test('canceling the comment modal does not add a note', async ({ mockedPage }) => {
    const featureRow = mockedPage.locator(featureRowSelector)
    await expect(featureRow).toBeVisible({ timeout: 10000 })

    await featureRow.locator('.worktree-more').click()
    await mockedPage.locator('.worktree-dropdown-item:has-text("Add comment")').click()

    const textarea = mockedPage.locator('.modal-textarea')
    await textarea.fill('discarded note')
    await mockedPage.getByRole('button', { name: 'Cancel' }).click()

    await expect(featureRow.locator('.worktree-comment-text')).toHaveCount(0)
  })
})
