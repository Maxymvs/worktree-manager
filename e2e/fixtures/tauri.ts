import { test as base, expect, Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

export interface TestContext {
  name: string
  testRoot: string
  port: number
  configDir: string
  repoPath: string
}

function getTestContext(): TestContext {
  const testRoot = process.env.TEST_ROOT || '/tmp/grovr-test-default'
  const port = parseInt(process.env.TEST_PORT || '1420', 10)

  return {
    name: process.env.TEST_NAME || 'default',
    testRoot,
    port,
    configDir: path.join(testRoot, 'config'),
    repoPath: path.join(testRoot, 'repo'),
  }
}

export function readSettings(ctx: TestContext): Record<string, unknown> {
  const settingsPath = path.join(ctx.configDir, 'settings.json')
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
}

export function writeSettings(ctx: TestContext, settings: Record<string, unknown>): void {
  const settingsPath = path.join(ctx.configDir, 'settings.json')
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

/** Epoch-ms timestamp `days` days before now — used for stable worktree ages. */
const DAY_MS_AGO = (days: number): number => Date.now() - days * 24 * 60 * 60 * 1000

// Mock data for Tauri API
export const mockData = {
  settings: {
    ide: { type: 'preset', preset: 'code' },
    theme: 'system',
    launch_at_startup: false,
    default_worktree_template: '{project}.worktrees/{branch}',
    copy_paths: [],
    fetch_before_create: true,
    refresh_interval_minutes: 5,
    skip_open_ide_confirm: false,
    worktree_sort: 'name',
    onboarding_completed: true,
    projects: [
      { name: 'test-project', repo_path: '/tmp/test-project/repo' },
    ],
    github_configs: [],
    jira_configs: [],
  },
  // Creation times are expressed as offsets from load time so the rendered
  // relative age ("3d", "5w", …) is stable no matter when the suite runs.
  // Tests assert the shape of the label / the tooltip, not an exact string.
  worktrees: [
    { path: '/tmp/test-project/repo', branch: 'main', is_main: true, is_bare: false, is_detached: false, prunable: false, created_at_ms: DAY_MS_AGO(400) },
    { path: '/tmp/test-project/worktrees/feature-auth', branch: 'feature-auth', is_main: false, is_bare: false, is_detached: false, prunable: false, created_at_ms: DAY_MS_AGO(3) },
    { path: '/tmp/test-project/worktrees/feature-ui', branch: 'feature-ui', is_main: false, is_bare: false, is_detached: false, prunable: false, created_at_ms: DAY_MS_AGO(35) },
    { path: '/tmp/test-project/worktrees/detached-wt', branch: 'abc1234', is_main: false, is_bare: false, is_detached: true, prunable: false, created_at_ms: DAY_MS_AGO(1) },
    { path: '/tmp/test-project/worktrees/stale-wt', branch: 'old-feature', is_main: false, is_bare: false, is_detached: false, prunable: true, created_at_ms: DAY_MS_AGO(90) },
  ],
  branches: [
    { name: 'main', is_remote: false, is_head: true },
    { name: 'feature-auth', is_remote: false, is_head: false },
    { name: 'feature-ui', is_remote: false, is_head: false },
  ],
  runningServers: [
    // On the main worktree, so its hover card (which labels the date as a
    // clone rather than a worktree creation) is reachable in tests.
    { worktree_path: '/tmp/test-project/repo', port: 4000, pid: 12300, process_name: 'node', address: '127.0.0.1', uptime_secs: 600 },
    { worktree_path: '/tmp/test-project/worktrees/feature-auth', port: 5178, pid: 12345, process_name: 'node', address: '127.0.0.1', uptime_secs: 8130 },
    { worktree_path: '/tmp/test-project/worktrees/feature-auth', port: 8004, pid: 12346, process_name: 'python3.11', address: '*', uptime_secs: 45 },
  ],
  // Per-worktree memos (description/issue_number/comment), keyed by worktree path.
  worktreeMemos: {} as Record<string, { description?: string | null; issue_number?: string | null; comment?: string | null }>,
  // What `get_worktree_delete_risk` reports. Default: nothing at risk.
  deleteRisk: {
    has_uncommitted_changes: false,
    unpushed_commits: 0,
    branch_content_merged: false,
  } as {
    has_uncommitted_changes: boolean
    unpushed_commits: number
    branch_content_merged: boolean
  },
  // GitHub integration. `null` (the default) means "not configured", which
  // keeps PR lookups from running at all.
  githubConfig: null as null | {
    id: string
    name: string
    config_type: 'personal' | 'enterprise'
    host?: string
    username?: string
  },
  githubRemoteInfo: { owner: 'test-owner', repo: 'test-repo' } as { owner: string; repo: string } | null,
  // PRs returned by `fetch_pull_requests`, keyed by branch name.
  pullRequests: {} as Record<
    string,
    Array<{
      number: number
      title: string
      state: string
      merged: boolean
      draft: boolean
      url: string
      review_decision?: string
      checks_status?: string
    }>
  >,
}

export type MockData = typeof mockData

/** Shallow-per-key merge of `overrides` onto the default mock data. */
export function withMockData(overrides: Partial<MockData>): MockData {
  return { ...mockData, ...overrides }
}

// Script to inject Tauri mock into the page
function getTauriMockScript(data: typeof mockData) {
  return `
    // Stateful per-page-session memo store so set_worktree_memo writes are
    // reflected by get_worktree_memo within a test.
    const worktreeMemos = ${JSON.stringify(data.worktreeMemos ?? {})};
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        console.log('[Tauri Mock] invoke:', cmd, args);
        const mockData = ${JSON.stringify(data)};

        switch (cmd) {
          case 'get_settings':
            return mockData.settings;
          case 'get_projects':
            return mockData.settings.projects;
          case 'get_worktrees':
            return mockData.worktrees;
          case 'get_running_servers':
            return mockData.runningServers;
          case 'stop_worktree_processes':
            return [];
          case 'get_worktree_delete_risk':
            return mockData.deleteRisk;
          case 'get_branches':
            return mockData.branches;
          case 'get_github_config':
            return mockData.githubConfig;
          case 'get_github_remote_info':
            return mockData.githubRemoteInfo;
          case 'fetch_pull_requests':
            return mockData.pullRequests[args.branch] ?? [];
          case 'get_jira_config':
            return null;
          case 'get_worktree_memo':
            return worktreeMemos[args.path] ?? { description: null, issue_number: null, comment: null };
          case 'set_worktree_memo':
            worktreeMemos[args.path] = args.memo;
            return null;
          case 'remove_worktree':
            // Deliberately slow: the delete runs in the background while the
            // row shows an inline "Deleting…" badge, and a test needs a window
            // in which to observe that state.
            await new Promise((r) => setTimeout(r, 1500));
            return null;
          case 'set_theme':
          case 'set_ide':
          case 'set_skip_open_ide_confirm':
          case 'set_worktree_sort':
          case 'create_worktree':
            return null;
          default:
            console.warn('[Tauri Mock] Unhandled command:', cmd);
            return null;
        }
      },
      transformCallback: () => 0,
    };

    // Also mock the Tauri core module
    window.__TAURI__ = {
      core: {
        invoke: window.__TAURI_INTERNALS__.invoke,
      },
    };
  `;
}

// Tauri web view fixture (testing via browser)
export const test = base.extend<{
  ctx: TestContext
  appPage: Page
  mockedPage: Page
  /**
   * Factory for a mocked page with per-test mock overrides — for cases where
   * the shared defaults aren't enough (a specific delete risk, a merged PR…).
   * Call it once per test, before touching the page.
   */
  mockedPageWith: (overrides: Partial<MockData>) => Promise<Page>
}>({
  ctx: async ({}, use) => {
    await use(getTestContext())
  },

  appPage: async ({ page, ctx }, use) => {
    const baseURL = `http://localhost:${ctx.port}`
    await page.goto(baseURL)
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },

  // Page with Tauri API mocked
  mockedPage: async ({ page, ctx }, use) => {
    const baseURL = `http://localhost:${ctx.port}`

    // Inject mock before page loads
    await page.addInitScript(getTauriMockScript(mockData))

    await page.goto(baseURL)
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },

  // Same as `mockedPage`, but the caller supplies mock overrides first.
  mockedPageWith: async ({ page, ctx }, use) => {
    const baseURL = `http://localhost:${ctx.port}`
    await use(async (overrides: Partial<MockData>) => {
      await page.addInitScript(getTauriMockScript(withMockData(overrides)))
      await page.goto(baseURL)
      await page.waitForLoadState('domcontentloaded')
      return page
    })
  },
})

export { expect, mockData as defaultMockData }
