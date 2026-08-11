import { test, expect } from '../fixtures/tauri'
import type { Page } from '@playwright/test'

// The "unsaved work" warning must fire for work that would genuinely be lost —
// and stay quiet otherwise. `unpushed_commits` counts by SHA, so a squash- or
// rebase-merged branch always looks unpushed; the backend's content check and a
// merged GitHub PR are the two signals that prove the work already landed.
test.describe('Worktree delete risk gate @worktree', () => {
  const MERGED_PR = {
    number: 2879,
    title: 'Add auth flow',
    state: 'closed',
    merged: true,
    draft: false,
    url: 'https://github.com/test-owner/test-repo/pull/2879',
  }

  const GITHUB_CONFIG = {
    id: 'gh-1',
    name: 'GitHub',
    config_type: 'personal' as const,
    username: 'tester',
  }

  /** Open the delete dialog for the feature-auth worktree. */
  async function openDeleteDialog(page: Page) {
    await page.locator('.worktree-row').first().waitFor({ timeout: 10000 })
    const row = page.locator('.worktree-row:has-text("feature-auth")')
    await row.locator('.worktree-more').click()
    await page.locator('.worktree-actions-dropdown-portal').waitFor()
    await page.locator('.worktree-dropdown-item-danger:has-text("Delete")').click()
    await expect(page.getByRole('heading', { name: 'Delete Worktree' })).toBeVisible()
    return row
  }

  const riskHeading = (page: Page) =>
    page.getByRole('heading', { name: 'Delete worktree with unsaved work?' })

  test('squash-merged commits do not trigger the warning', async ({ mockedPageWith }) => {
    const page = await mockedPageWith({
      deleteRisk: {
        has_uncommitted_changes: false,
        unpushed_commits: 6,
        branch_content_merged: true,
      },
    })

    const row = await openDeleteDialog(page)
    await page.getByRole('button', { name: /^Delete/ }).click()

    // No warning; the delete goes straight through.
    await expect(riskHeading(page)).toHaveCount(0)
    await expect(row.getByTestId('deleting-badge')).toBeVisible()
  })

  test('a merged PR suppresses the warning even without the content check', async ({
    mockedPageWith,
  }) => {
    const page = await mockedPageWith({
      deleteRisk: {
        has_uncommitted_changes: false,
        unpushed_commits: 6,
        branch_content_merged: false,
      },
      githubConfig: GITHUB_CONFIG,
      pullRequests: { 'feature-auth': [MERGED_PR] },
    })

    // Wait for the PR badge so the row's prInfo is hydrated before deleting.
    const row = page.locator('.worktree-row:has-text("feature-auth")')
    await expect(row.getByText('#2879')).toBeVisible({ timeout: 10000 })

    await openDeleteDialog(page)
    await page.getByRole('button', { name: /^Delete/ }).click()

    await expect(riskHeading(page)).toHaveCount(0)
    await expect(row.getByTestId('deleting-badge')).toBeVisible()
  })

  test('genuinely unpushed commits still warn', async ({ mockedPageWith }) => {
    const page = await mockedPageWith({
      deleteRisk: {
        has_uncommitted_changes: false,
        unpushed_commits: 2,
        branch_content_merged: false,
      },
    })

    await openDeleteDialog(page)
    await page.getByRole('button', { name: /^Delete/ }).click()

    await expect(riskHeading(page)).toBeVisible()
    await expect(page.getByText(/2 unpushed commits/)).toBeVisible()
  })

  test('uncommitted changes warn even when the branch content is merged', async ({
    mockedPageWith,
  }) => {
    const page = await mockedPageWith({
      deleteRisk: {
        has_uncommitted_changes: true,
        unpushed_commits: 6,
        branch_content_merged: true,
      },
    })

    await openDeleteDialog(page)
    await page.getByRole('button', { name: /^Delete/ }).click()

    await expect(riskHeading(page)).toBeVisible()
    await expect(page.getByText(/uncommitted changes/)).toBeVisible()
  })

  test('the primary dialog explains why a merged-PR branch is safe', async ({
    mockedPageWith,
  }) => {
    const page = await mockedPageWith({
      githubConfig: GITHUB_CONFIG,
      pullRequests: { 'feature-auth': [MERGED_PR] },
    })

    const row = page.locator('.worktree-row:has-text("feature-auth")')
    await expect(row.getByText('#2879')).toBeVisible({ timeout: 10000 })

    await openDeleteDialog(page)

    const note = page.getByTestId('pr-merged-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('PR #2879 was merged')
  })

  test('a worktree without a merged PR shows no merged-PR note', async ({ mockedPage }) => {
    await openDeleteDialog(mockedPage)
    await expect(mockedPage.getByTestId('pr-merged-note')).toHaveCount(0)
  })
})
