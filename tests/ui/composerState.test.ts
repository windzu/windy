import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerSubmitLabel,
  isActiveConversationStatus,
  shouldReuseComposer,
} from '../../src/ui/composerState';

test('keeps message submission available while the active turn is working', () => {
  for (const status of ['running', 'waiting-approval', 'waiting-input'] as const) {
    assert.equal(isActiveConversationStatus(status), true);
    assert.equal(composerSubmitLabel(status), 'Queue message');
  }
  assert.equal(isActiveConversationStatus('completed'), false);
  assert.equal(composerSubmitLabel('completed'), 'Send message');
});

test('reuses the composer DOM for snapshots from the same conversation', () => {
  assert.equal(shouldReuseComposer('conversation:a', 'conversation:a', false), true);
  assert.equal(shouldReuseComposer('conversation:a', 'conversation:b', false), false);
  assert.equal(shouldReuseComposer('conversation:a', 'conversation:a', true), false);
  assert.equal(shouldReuseComposer(null, 'conversation:a', false), false);
});
