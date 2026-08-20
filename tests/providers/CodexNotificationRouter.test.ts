import assert from 'node:assert/strict';
import test from 'node:test';

import type { StreamChunk } from '../../src/core/types';
import { CodexNotificationRouter } from '../../src/providers/codex/runtime/CodexNotificationRouter';

test('streams nested exec-envelope tools as separate live activities', () => {
  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk));
  router.beginTurn({ isPlanTurn: false });

  router.handleNotification('rawResponseItem/completed', {
    item: {
      type: 'function_call',
      name: 'exec',
      call_id: 'exec-1',
      arguments: JSON.stringify({
        raw: [
          'const command = await tools.exec_command({ cmd: "npm test" });',
          'text(command.output);',
          'const viewed = await tools.view_image({ path: "shot.png" });',
          'image(viewed.image_url);',
        ].join('\n'),
      }),
    },
  });
  router.handleNotification('rawResponseItem/completed', {
    item: {
      type: 'function_call_output',
      call_id: 'exec-1',
      output: [
        { type: 'text', text: 'Script completed\nOutput:\n' },
        { type: 'text', text: 'tests passed' },
        { type: 'text', text: 'shot.png' },
      ],
    },
  });

  assert.deepEqual(chunks, [
    {
      type: 'tool_use',
      id: 'exec-1:1',
      name: 'Bash',
      input: { command: 'npm test' },
    },
    {
      type: 'tool_use',
      id: 'exec-1:2',
      name: 'Read',
      input: { path: 'shot.png', file_path: 'shot.png' },
    },
    {
      type: 'tool_result',
      id: 'exec-1:1',
      content: 'tests passed',
      isError: false,
    },
    {
      type: 'tool_result',
      id: 'exec-1:2',
      content: 'shot.png',
      isError: false,
    },
  ]);
});

test('streams readable reasoning summaries without mixing in raw reasoning', () => {
  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk));
  router.beginTurn({ isPlanTurn: false });

  router.handleNotification('item/reasoning/textDelta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'reasoning-1',
    delta: 'Raw model reasoning.',
  });
  router.handleNotification('item/reasoning/summaryTextDelta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'reasoning-1',
    summaryIndex: 0,
    delta: 'Inspecting the implementation.',
  });

  assert.deepEqual(chunks, [
    { type: 'thinking', content: 'Inspecting the implementation.' },
  ]);
});
