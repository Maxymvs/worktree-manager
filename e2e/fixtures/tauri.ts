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
    onboarding_completed: true,
    projects: [
      { name: 'test-project', repo_path: '/tmp/test-project/repo' },
    ],
    github_configs: [],
    jira_configs: [],
  },
  worktrees: [
    { path: '/tmp/test-project/repo', branch: 'main', is_main: true, is_bare: false, is_detached: false, prunable: false },
    { path: '/tmp/test-project/worktrees/feature-auth', branch: 'feature-auth', is_main: false, is_bare: false, is_detached: false, prunable: false },
    { path: '/tmp/test-project/worktrees/feature-ui', branch: 'feature-ui', is_main: false, is_bare: false, is_detached: false, prunable: false },
    { path: '/tmp/test-project/worktrees/detached-wt', branch: 'abc1234', is_main: false, is_bare: false, is_detached: true, prunable: false },
  ],
  branches: [
    { name: 'main', is_remote: false, is_head: true },
    { name: 'feature-auth', is_remote: false, is_head: false },
    { name: 'feature-ui', is_remote: false, is_head: false },
  ],
  runningServers: [
    { worktree_path: '/tmp/test-project/worktrees/feature-auth', port: 5178, pid: 12345, process_name: 'node', address: '127.0.0.1', uptime_secs: 8130 },
    { worktree_path: '/tmp/test-project/worktrees/feature-auth', port: 8004, pid: 12346, process_name: 'python3.11', address: '*', uptime_secs: 45 },
  ],
  // Per-worktree memos (description/issue_number/comment), keyed by worktree path.
  worktreeMemos: {} as Record<string, { description?: string | null; issue_number?: string | null; comment?: string | null }>,
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
          case 'get_branches':
            return mockData.branches;
          case 'get_github_config':
            return null;
          case 'get_jira_config':
            return null;
          case 'get_worktree_memo':
            return worktreeMemos[args.path] ?? { description: null, issue_number: null, comment: null };
          case 'set_worktree_memo':
            worktreeMemos[args.path] = args.memo;
            return null;
          case 'set_theme':
          case 'set_ide':
          case 'set_skip_open_ide_confirm':
          case 'remove_worktree':
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
})

export { expect, mockData as defaultMockData }
