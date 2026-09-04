import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, ToolCallInfo } from '../../src/core/types';
import {
  buildActivityViewModel,
  elapsedTurnSeconds,
  formatActivityToolTitle,
  formatActivitySummary,
  formatDuration,
} from '../../src/ui/activityFormatting';

function assistantMessage(
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Done',
    timestamp: 1,
    ...overrides,
  };
}

function toolCall(
  name: string,
  input: Record<string, unknown>,
  status: ToolCallInfo['status'] = 'completed',
): ToolCallInfo {
  return {
    id: name,
    name,
    input,
    status,
  };
}

test('formats durations without a model-generated summary', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(42), '42s');
  assert.equal(formatDuration(102), '1m 42s');
  assert.equal(formatDuration(3_720), '1h 2m');
  assert.equal(elapsedTurnSeconds(1_000, 13_900), 12);
  assert.equal(elapsedTurnSeconds(10_000, 9_000), 0);
  assert.equal(formatActivitySummary('running', 12), 'Working for 12s');
  assert.equal(
    formatActivitySummary('waiting-approval', 12),
    'Waiting for approval · 12s',
  );
});

test('derives readable activity titles from structured tool input', () => {
  assert.equal(
    formatActivityToolTitle(toolCall('Bash', { command: 'npm test' })),
    'Ran npm test',
  );
  assert.equal(
    formatActivityToolTitle(toolCall('apply_patch', {
      changes: [{ path: 'src/ui/MessageListRenderer.ts' }],
    })),
    'Edited src/ui/MessageListRenderer.ts',
  );
  assert.equal(
    formatActivityToolTitle(toolCall('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts',
    })),
    'Edited 2 files',
  );
  assert.equal(
    formatActivityToolTitle(toolCall('WebSearch', { query: 'Obsidian API' })),
    'Searched the web for Obsidian API',
  );
  assert.equal(
    formatActivityToolTitle(toolCall('Read', { file_path: 'assets/view.png' })),
    'Viewed assets/view.png',
  );
  assert.equal(
    formatActivityToolTitle(toolCall('mcp__github__get_issue', {})),
    'Used Get issue via Github',
  );
});

test('preserves activity order while coalescing reasoning deltas', () => {
  const command = toolCall('Bash', { command: 'npm test' });
  command.id = 'command-1';
  const edit = toolCall('apply_patch', {
    changes: [{ path: 'src/app.ts' }],
  });
  edit.id = 'edit-1';

  const model = buildActivityViewModel(assistantMessage({
    durationSeconds: 62,
    turnStatus: 'completed',
    toolCalls: [command, edit],
    contentBlocks: [
      { type: 'thinking', content: 'Inspecting ' },
      { type: 'thinking', content: 'the code.' },
      { type: 'tool_use', toolId: 'command-1' },
      { type: 'text', content: 'I found the cause.' },
      { type: 'tool_use', toolId: 'edit-1' },
      { type: 'context_compacted' },
    ],
  }), false, 'idle');

  assert.equal(model.summary, 'Worked for 1m 2s');
  assert.equal(model.defaultExpanded, false);
  assert.deepEqual(
    model.items.map(item => item.title),
    [
      'Reasoning',
      'Ran npm test',
      'Edited src/app.ts',
      'Compacted the conversation context',
    ],
  );
});

test('keeps active turns expanded while reporting live elapsed time', () => {
  const model = buildActivityViewModel(
    assistantMessage({
      content: '',
      contentBlocks: [
        { type: 'thinking', content: '**Inspecting the activity renderer**\n\nReading the UI state.' },
      ],
    }),
    true,
    'running',
    12,
  );

  assert.equal(model.summary, 'Working for 12s');
  assert.equal(model.currentActivity, 'Inspecting the activity renderer');
  assert.equal(model.defaultExpanded, true);
  assert.equal(model.shouldRender, true);
  assert.equal(model.items.length, 1);
});

test('uses the latest tool title as the current activity', () => {
  const command = toolCall('Bash', { command: 'npm test' }, 'running');
  command.id = 'command-1';
  const model = buildActivityViewModel(assistantMessage({
    content: '',
    toolCalls: [command],
    contentBlocks: [{ type: 'tool_use', toolId: command.id }],
  }), true, 'running');

  assert.equal(model.currentActivity, 'Ran npm test');
  assert.equal(model.defaultExpanded, true);
});

test('keeps commentary and tool activity in provider order', () => {
  const command = toolCall('Bash', { command: 'npm test' });
  command.id = 'command-1';
  const model = buildActivityViewModel(assistantMessage({
    content: 'Done.',
    toolCalls: [command],
    contentBlocks: [
      {
        type: 'text',
        content: 'I will inspect the renderer first.',
        phase: 'commentary',
        itemId: 'commentary-1',
      },
      { type: 'tool_use', toolId: command.id },
      {
        type: 'text',
        content: 'Done.',
        phase: 'final_answer',
        itemId: 'final-1',
      },
    ],
  }), false, 'idle');

  assert.deepEqual(
    model.items.map(item => [item.kind, item.title, item.detail]),
    [
      ['commentary', 'Update', 'I will inspect the renderer first.'],
      ['tool', 'Ran npm test', undefined],
    ],
  );
});

test('uses persisted terminal state after the runtime is reloaded', () => {
  const model = buildActivityViewModel(assistantMessage({
    durationSeconds: 8,
    turnStatus: 'cancelled',
  }), true, 'idle');

  assert.equal(model.state, 'cancelled');
  assert.equal(model.summary, 'Stopped after 8s');
  assert.equal(model.defaultExpanded, false);
});
