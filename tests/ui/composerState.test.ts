import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerSubmitLabel,
  isActiveConversationStatus,
} from '../../src/ui/composerState';

test('keeps message submission available while the active turn is working', () => {
  for (const status of ['running', 'waiting-approval', 'waiting-input'] as const) {
    assert.equal(isActiveConversationStatus(status), true);
    assert.equal(composerSubmitLabel(status), 'Queue message');
  }
  assert.equal(isActiveConversationStatus('completed'), false);
  assert.equal(composerSubmitLabel('completed'), 'Send message');
});
