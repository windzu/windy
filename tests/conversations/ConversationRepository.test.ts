import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Conversation } from '../../src/core/types';
import {
  CONVERSATION_DOCUMENT_VERSION,
} from '../../src/conversations/ConversationDocument';
import { ConversationRepository } from '../../src/conversations/ConversationRepository';
import { MemoryJsonFileAdapter } from '../helpers/MemoryJsonFileAdapter';

function conversation(id: string): Conversation {
  return {
    id,
    providerId: 'codex',
    title: 'Legacy conversation',
    createdAt: 100,
    updatedAt: 200,
    sessionId: 'thread-1',
    selectedModel: 'gpt-5.6-codex',
    messages: [],
  };
}

describe('ConversationRepository', () => {
  it('reads legacy documents and upgrades them on the next normal save', async () => {
    const path = '.windy/conversations/legacy.json';
    const adapter = new MemoryJsonFileAdapter({
      [path]: JSON.stringify(conversation('legacy')),
    });
    const repository = new ConversationRepository(adapter);

    const loaded = await repository.load('legacy');
    assert.equal(loaded?.title, 'Legacy conversation');
    assert.deepEqual(adapter.readJson(path), conversation('legacy'));

    await repository.save(loaded!);
    const stored = adapter.readJson(path) as {
      version: number;
      conversation: Conversation;
    };
    assert.equal(stored.version, CONVERSATION_DOCUMENT_VERSION);
    assert.equal(stored.conversation.id, 'legacy');
    assert.equal(stored.conversation.sessionId, 'thread-1');
  });

  it('reads version 1 envelopes and upgrades them to the current version', async () => {
    const path = '.windy/conversations/v1.json';
    const adapter = new MemoryJsonFileAdapter({
      [path]: JSON.stringify({
        version: 1,
        conversation: conversation('v1'),
      }),
    });
    const repository = new ConversationRepository(adapter);

    const loaded = await repository.load('v1');
    assert.equal(loaded?.id, 'v1');
    await repository.save(loaded!);

    assert.equal(
      (adapter.readJson(path) as { version: number }).version,
      CONVERSATION_DOCUMENT_VERSION,
    );
  });

  it('rejects unsupported versions and mismatched ids without modifying data', async () => {
    const versionedPath = '.windy/conversations/future.json';
    const mismatchedPath = '.windy/conversations/expected.json';
    const adapter = new MemoryJsonFileAdapter({
      [versionedPath]: JSON.stringify({
        version: 99,
        conversation: conversation('future'),
      }),
      [mismatchedPath]: JSON.stringify(conversation('different')),
    });
    const repository = new ConversationRepository(adapter);

    await assert.rejects(
      repository.load('future'),
      /unsupported schema version "99"/,
    );
    await assert.rejects(
      repository.load('expected'),
      /contains a different id/,
    );
    assert.equal(
      (adapter.readJson(versionedPath) as { version: number }).version,
      99,
    );
  });

  it('rejects malformed persisted turn state', async () => {
    const path = '.windy/conversations/malformed.json';
    const malformed = conversation('malformed');
    malformed.activeTurn = {
      status: 'running',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      primaryPagePath: 'A.md',
      startedAt: Number.NaN,
      updatedAt: 2,
    };
    const adapter = new MemoryJsonFileAdapter({
      [path]: JSON.stringify({
        version: CONVERSATION_DOCUMENT_VERSION,
        conversation: malformed,
      }),
    });
    const repository = new ConversationRepository(adapter);

    await assert.rejects(
      repository.load('malformed'),
      /invalid schema/,
    );
  });

  it('accepts a persisted turn that was waiting for user input', async () => {
    const path = '.windy/conversations/waiting-input.json';
    const stored = conversation('waiting-input');
    stored.activeTurn = {
      status: 'waiting-input',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      primaryPagePath: 'A.md',
      startedAt: 1,
      updatedAt: 2,
    };
    const repository = new ConversationRepository(
      new MemoryJsonFileAdapter({
        [path]: JSON.stringify({
          version: CONVERSATION_DOCUMENT_VERSION,
          conversation: stored,
        }),
      }),
    );

    assert.equal(
      (await repository.load('waiting-input'))?.activeTurn?.status,
      'waiting-input',
    );
  });

  it('persists queued turns in FIFO order', async () => {
    const path = '.windy/conversations/queued.json';
    const stored = conversation('queued');
    stored.queuedTurns = [
      {
        id: 'queued-1',
        content: 'second',
        primaryPagePath: 'A.md',
        createdAt: 300,
      },
      {
        id: 'queued-2',
        content: 'third',
        primaryPagePath: 'A.md',
        createdAt: 301,
      },
    ];
    const repository = new ConversationRepository(
      new MemoryJsonFileAdapter({
        [path]: JSON.stringify({
          version: CONVERSATION_DOCUMENT_VERSION,
          conversation: stored,
        }),
      }),
    );

    assert.deepEqual(
      (await repository.load('queued'))?.queuedTurns?.map(turn => turn.content),
      ['second', 'third'],
    );
  });

  it('repairs duplicate tool events while preserving a terminal result', async () => {
    const path = '.windy/conversations/duplicate-tools.json';
    const stored = conversation('duplicate-tools');
    stored.messages = [{
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done',
      timestamp: 100,
      toolCalls: [
        {
          id: 'patch-1',
          name: 'apply_patch',
          input: { patch: 'first' },
          status: 'completed',
          result: 'updated A.md',
        },
        {
          id: 'patch-1',
          name: 'apply_patch',
          input: { patch: 'latest' },
          status: 'running',
        },
      ],
      contentBlocks: [
        { type: 'tool_use', toolId: 'patch-1' },
        { type: 'tool_use', toolId: 'patch-1' },
        { type: 'text', content: 'Done' },
      ],
    }];
    const adapter = new MemoryJsonFileAdapter({
      [path]: JSON.stringify({
        version: CONVERSATION_DOCUMENT_VERSION,
        conversation: stored,
      }),
    });
    const repository = new ConversationRepository(adapter);

    const loaded = await repository.load('duplicate-tools');
    const assistant = loaded?.messages[0];

    assert.deepEqual(assistant?.toolCalls, [{
      id: 'patch-1',
      name: 'apply_patch',
      input: { patch: 'latest' },
      status: 'completed',
      result: 'updated A.md',
      providerPayload: undefined,
    }]);
    assert.deepEqual(assistant?.contentBlocks, [
      { type: 'tool_use', toolId: 'patch-1' },
      { type: 'text', content: 'Done' },
    ]);
  });

  it('treats unsafe ids as unavailable instead of resolving outside storage', async () => {
    const repository = new ConversationRepository(
      new MemoryJsonFileAdapter(),
    );

    assert.equal(await repository.exists('../outside'), false);
    await assert.rejects(
      repository.load('../outside'),
      /Invalid conversation id/,
    );
  });
});
