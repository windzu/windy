import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';

import { mergeWindySettings } from '../../src/app/settings';
import { WindyProviderHost } from '../../src/app/WindyProviderHost';

test('pins the executable for active sessions and applies changes on plugin reload', async () => {
  const settings = mergeWindySettings({
    providerConfigs: { codex: { cliPath: process.execPath } },
  });
  const host = new WindyProviderHost({} as App, settings, {});
  assert.equal(await host.getResolvedProviderCliPath('codex'), process.execPath);
  settings.providerConfigs.codex!.cliPath = 'custom-codex';
  assert.equal(await host.getResolvedProviderCliPath('codex', {
    executionTarget: { method: 'host-native' },
  }), process.execPath);
  const reloaded = new WindyProviderHost({} as App, settings, {});
  assert.equal(await reloaded.getResolvedProviderCliPath('codex'), 'custom-codex');
});

test('keeps WSL resolution separate from native desktop discovery', async () => {
  const settings = mergeWindySettings({
    providerConfigs: { codex: { cliPath: process.execPath } },
  });
  const host = new WindyProviderHost({} as App, settings, {});
  await host.getResolvedProviderCliPath('codex');
  settings.providerConfigs.codex!.cliPath = '/linux-only/bin/codex';
  assert.equal(await host.getResolvedProviderCliPath('codex', {
    executionTarget: { method: 'wsl', distroName: 'Ubuntu' },
  }), '/linux-only/bin/codex');
});
