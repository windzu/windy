import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureMessageScrollPosition,
  MessageScrollPositionStore,
  restoreMessageScrollPosition,
} from '../../src/ui/messageScrollPosition';

interface TestScroller {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

test('keeps consecutive message renders pinned to the bottom', () => {
  const previous: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 600,
  };
  const position = captureMessageScrollPosition(previous);
  const replacement: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 0,
  };

  restoreMessageScrollPosition(replacement, position);

  assert.equal(replacement.scrollTop, 1_200);
  assert.equal(
    captureMessageScrollPosition(replacement).stickToBottom,
    true,
  );
});

test('preserves the position when the user has scrolled away from the bottom', () => {
  const previous: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 250,
  };
  const position = captureMessageScrollPosition(previous);
  const replacement: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 0,
  };

  restoreMessageScrollPosition(replacement, position);

  assert.equal(replacement.scrollTop, 250);
  assert.equal(position.stickToBottom, false);
});

test('keeps scroll positions isolated between conversations', () => {
  const store = new MessageScrollPositionStore();
  const firstConversation: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 250,
  };

  const firstPosition = store.prepareForRender('conversation-a', null);
  assert.equal(firstPosition.stickToBottom, true);

  const unseenConversation = store.prepareForRender(
    'conversation-b',
    firstConversation,
  );
  assert.deepEqual(unseenConversation, {
    scrollTop: 0,
    stickToBottom: true,
  });

  const secondConversation: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_400,
    scrollTop: 900,
  };
  const restoredFirstConversation = store.prepareForRender(
    'conversation-a',
    secondConversation,
  );
  assert.deepEqual(restoredFirstConversation, {
    scrollTop: 250,
    stickToBottom: false,
  });
});

test('preserves the active conversation position across consecutive renders', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);

  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 300,
  };
  assert.deepEqual(store.prepareForRender('conversation-a', current), {
    scrollTop: 300,
    stickToBottom: false,
  });
});

test('manual scrolling overrides a pending bottom restoration', () => {
  const store = new MessageScrollPositionStore();
  const previous: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 600,
  };
  const initialPosition = store.prepareForRender('conversation-a', previous);
  const replacement: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 800,
  };
  store.trackActiveContainer('conversation-a', replacement);
  store.restoreActivePosition(
    'conversation-a',
    replacement,
    initialPosition,
  );

  assert.equal(initialPosition.stickToBottom, true);

  replacement.scrollTop = 250;
  store.recordActiveScroll('conversation-a', replacement);
  restoreMessageScrollPosition(
    replacement,
    store.getPosition('conversation-a'),
  );

  assert.equal(replacement.scrollTop, 250);
  assert.equal(store.getPosition('conversation-a').stickToBottom, false);
});

test('upward intent suspends following before the browser scroll event', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 800,
  };
  store.trackActiveContainer('conversation-a', current);

  store.pauseActiveFollowing('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), false);
  assert.deepEqual(store.getPosition('conversation-a'), {
    scrollTop: 800,
    stickToBottom: false,
  });
});

test('a small upward gesture stays suspended inside the bottom tolerance', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 800,
  };
  store.trackActiveContainer('conversation-a', current);
  store.pauseActiveFollowing('conversation-a', current);

  current.scrollTop = 790;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), false);
  assert.equal(store.getPosition('conversation-a').scrollTop, 790);
  assert.deepEqual(store.prepareForRender('conversation-a', current), {
    scrollTop: 790,
    stickToBottom: false,
  });
  store.trackActiveContainer('conversation-a', current);

  current.scrollTop = 800;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), true);
});

test('a manual scroll event can suspend following without wheel intent', () => {
  const store = new MessageScrollPositionStore();
  const position = store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 0,
  };
  store.trackActiveContainer('conversation-a', current);
  store.restoreActivePosition('conversation-a', current, position);
  store.recordActiveScroll('conversation-a', current);

  current.scrollTop = 790;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), false);
  assert.equal(store.getPosition('conversation-a').scrollTop, 790);
});

test('explicitly returning to latest restores automatic following', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 250,
  };
  store.trackActiveContainer('conversation-a', current);
  store.pauseActiveFollowing('conversation-a', current);

  store.resumeActiveFollowing('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), true);
  assert.equal(current.scrollTop, 1_200);
});

test('does not treat a programmatic restoration as manual scrolling', () => {
  const store = new MessageScrollPositionStore();
  const position = store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 0,
  };
  store.trackActiveContainer('conversation-a', current);

  store.restoreActivePosition('conversation-a', current, position);
  current.scrollHeight = 1_400;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.getPosition('conversation-a').stickToBottom, true);
});

test('keeps a manual position outside the bottom tolerance across renders', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 770,
  };
  store.trackActiveContainer('conversation-a', current);

  store.recordActiveScroll('conversation-a', current);
  const nextPosition = store.prepareForRender('conversation-a', current);

  assert.deepEqual(nextPosition, {
    scrollTop: 770,
    stickToBottom: false,
  });
});

test('scrolling back to the bottom resumes automatic following', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 250,
  };
  store.trackActiveContainer('conversation-a', current);

  store.recordActiveScroll('conversation-a', current);
  current.scrollTop = 800;
  store.recordActiveScroll('conversation-a', current);

  const replacement: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_500,
    scrollTop: 0,
  };
  restoreMessageScrollPosition(
    replacement,
    store.getPosition('conversation-a'),
  );

  assert.equal(replacement.scrollTop, 1_500);
  assert.equal(store.getPosition('conversation-a').stickToBottom, true);
});

test('partial downward scrolling keeps automatic following suspended', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 250,
  };
  store.trackActiveContainer('conversation-a', current);
  store.pauseActiveFollowing('conversation-a', current);

  current.scrollTop = 700;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), false);
  assert.equal(store.getPosition('conversation-a').scrollTop, 700);
});

test('returning within the bottom tolerance resumes following', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const current: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 250,
  };
  store.trackActiveContainer('conversation-a', current);
  store.pauseActiveFollowing('conversation-a', current);

  current.scrollTop = 780;
  store.recordActiveScroll('conversation-a', current);

  assert.equal(store.isFollowing('conversation-a'), true);
});

test('ignores stale scroll events from an inactive conversation', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  store.prepareForRender('conversation-b', null);
  const active: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 600,
  };
  store.trackActiveContainer('conversation-b', active);

  store.recordActiveScroll('conversation-a', {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 200,
  });

  assert.deepEqual(store.getPosition('conversation-b'), {
    scrollTop: 0,
    stickToBottom: true,
  });
});

test('ignores delayed scroll events from a replaced container', () => {
  const store = new MessageScrollPositionStore();
  store.prepareForRender('conversation-a', null);
  const replaced: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_000,
    scrollTop: 200,
  };
  const active: TestScroller = {
    clientHeight: 400,
    scrollHeight: 1_200,
    scrollTop: 350,
  };
  store.trackActiveContainer('conversation-a', active);
  store.recordActiveScroll('conversation-a', active);

  store.recordActiveScroll('conversation-a', replaced);

  assert.deepEqual(store.getPosition('conversation-a'), {
    scrollTop: 350,
    stickToBottom: false,
  });
});
