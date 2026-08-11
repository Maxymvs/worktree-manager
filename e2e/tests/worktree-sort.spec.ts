import { test, expect } from '../fixtures/tauri'

/**
 * Branch labels in rendered (DOM) order. Detached worktrees render their SHA in
 * a different element, so both are collected.
 */
function branchOrder(page: import('@playwright/test').Page) {
  return page.locator('.worktree-branch-name, .worktree-branch-detached')
}

async function openSortMenu(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Sort worktrees' }).click()
  await expect(page.getByRole('menu', { name: 'Sort worktrees' })).toBeVisible()
}

async function chooseSort(page: import('@playwright/test').Page, label: string) {
  await openSortMenu(page)
  await page.getByRole('menuitemradio', { name: label }).click()
  await expect(page.getByRole('menu', { name: 'Sort worktrees' })).toBeHidden()
}

test.describe('Worktree Sort @worktree', () => {
  test('sort menu opens from the titlebar with all modes', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await openSortMenu(mockedPage)

    for (const label of [
      'Name (A–Z)',
      'Name (Z–A)',
      'Newest first',
      'Oldest first',
      'Longest running',
    ]) {
      await expect(mockedPage.getByRole('menuitemradio', { name: label })).toBeVisible()
    }

    // Default mode is Name (A–Z)
    await expect(
      mockedPage.getByRole('menuitemradio', { name: 'Name (A–Z)' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  test('default order is alphabetical, main not pinned', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage)).toHaveText(
      ['abc1234', 'feature-auth', 'feature-ui', 'main', 'old-feature'],
      { timeout: 10000 }
    )
  })

  test('Name (Z–A) reverses the visible branch order', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await chooseSort(mockedPage, 'Name (Z–A)')

    await expect(branchOrder(mockedPage)).toHaveText([
      'old-feature',
      'main',
      'feature-ui',
      'feature-auth',
      'abc1234',
    ])
  })

  test('Newest first puts the most recently created worktree on top', async ({
    mockedPage,
  }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await chooseSort(mockedPage, 'Newest first')

    // Fixture ages: abc1234 1d, feature-auth 3d, feature-ui 35d,
    // old-feature 90d, main 400d.
    await expect(branchOrder(mockedPage)).toHaveText([
      'abc1234',
      'feature-auth',
      'feature-ui',
      'old-feature',
      'main',
    ])
  })

  test('Oldest first reverses the chronological order', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await chooseSort(mockedPage, 'Oldest first')

    await expect(branchOrder(mockedPage)).toHaveText([
      'main',
      'old-feature',
      'feature-ui',
      'feature-auth',
      'abc1234',
    ])
  })

  test('Longest running ranks worktrees by dev-server uptime', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await chooseSort(mockedPage, 'Longest running')

    // feature-auth's busiest server has been up 8130s, the main repo's 600s;
    // the remaining zero-uptime rows fall back to alphabetical order.
    await expect(branchOrder(mockedPage)).toHaveText([
      'feature-auth',
      'main',
      'abc1234',
      'feature-ui',
      'old-feature',
    ])
  })

  test('selected mode is checked when the menu is reopened', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await chooseSort(mockedPage, 'Newest first')
    await openSortMenu(mockedPage)

    await expect(
      mockedPage.getByRole('menuitemradio', { name: 'Newest first' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  test('Escape closes the sort menu', async ({ mockedPage }) => {
    await expect(branchOrder(mockedPage).first()).toBeVisible({ timeout: 10000 })

    await openSortMenu(mockedPage)
    await mockedPage.keyboard.press('Escape')

    await expect(mockedPage.getByRole('menu', { name: 'Sort worktrees' })).toBeHidden()
  })
})
