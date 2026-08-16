import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CODEX_PROVIDER_CONFIG,
  getCodexProviderSettings,
} from '../../src/providers/codex/settings';

test('uses concise reasoning summaries by default', () => {
  assert.equal(DEFAULT_CODEX_PROVIDER_CONFIG.reasoningSummary, 'concise');
});

test('migrates the legacy detailed reasoning summary to concise', () => {
  const settings = {
    providerConfigs: {
      codex: {
        reasoningSummary: 'detailed',
      },
    },
  };

  assert.equal(getCodexProviderSettings(settings).reasoningSummary, 'concise');
});
