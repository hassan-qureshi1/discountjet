import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '.worktrees/**',
      '.claude/worktrees/**',
      'node_modules/**',
      'functions/**',
      'backend/**',
      'api/**',
      'tests/notificationCreate.test.js',
      'tests/notification.test.js',
      'tests/settings.test.js',
      'tests/slacknotify.test.js',
      'tests/smsnotify.test.js',
      'tests/digestCommunication.test.js',
      'tests/notificationProcessor.test.js',
    ],
  },
});
