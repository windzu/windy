import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderHost } from '../../src/core/providers/ProviderHost';
import type { ChatRuntime } from '../../src/core/runtime/ChatRuntime';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  ChatRuntimeQueryOptions,
  ChatTurnRequest,
  PreparedChatTurn,
} from '../../src/core/runtime/types';
import type {
  ApprovalDecision,
  Conversation,
  StreamChunk,
} from '../../src/core/types';
import type { ConversationStore } from '../../src/conversations/ConversationRepository';
import { RuntimeCoordinator } from '../../src/runtime/RuntimeCoordinator';

class MemoryConversationStore implements ConversationStore {
  private failNextSave = false;

  constructor(private readonly conversations: Map<string, Conversation>) {}

  rejectNextSave(): void {
    this.failNextSave = true;
  }

  async load(conversationId: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(conversationId);
    return conversation ? structuredClone(conversation) : null;
  }

  async save(conversation: Conversation): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('save failed');
    }
    this.conversations.set(conversation.id, structuredClone(conversation));
  }
}

function conversation(id: string): Conversation {
  return {
    id,
    providerId: 'codex',
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    selectedModel: 'test-model',
    messages: [],
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFakeRuntime(options: {
  gateByConversation?: Map<string, Promise<void>>;
  approval?: boolean;
  userInput?: Record<string, unknown>;
  partialBeforeGate?: string;
  preparedRequests?: ChatTurnRequest[];
  scriptedChunks?: StreamChunk[];
  sessionTitles?: string[];
  sessionTitleError?: Error;
  queryOptions?: ChatRuntimeQueryOptions[];
  steeredRequests?: ChatTurnRequest[];
  steerAccepted?: boolean;
  steerError?: Error;
  steerGate?: Promise<void>;
  afterGateChunks?: StreamChunk[];
  steerChunksBeforeAccept?: StreamChunk[];
}): ChatRuntime {
  let conversationId = '';
  let approvalCallback: ApprovalCallback | null = null;
  let askUserCallback: AskUserQuestionCallback | null = null;
  let cancelled = false;
  let userInputRequested = false;
  const steerStarted = deferred();
  const steerChunksDelivered = deferred();
  const releaseSteeredQuery = deferred();

  const runtime = {
    syncConversationState(state: { id?: string } | null): void {
      conversationId = state?.id ?? '';
    },
    prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
      options.preparedRequests?.push(structuredClone(request));
      return {
        request,
        persistedContent: request.text,
        prompt: request.text,
        isCompact: false,
        mcpMentions: new Set(),
      };
    },
    async *query(
      _turn: PreparedChatTurn,
      _history: unknown,
      queryOptions: ChatRuntimeQueryOptions,
    ): AsyncGenerator<StreamChunk> {
      options.queryOptions?.push(structuredClone(queryOptions));
      if (options.scriptedChunks) {
        yield* options.scriptedChunks;
        yield { type: 'done' };
        return;
      }
      if (options.steerChunksBeforeAccept) {
        await steerStarted.promise;
        yield* options.steerChunksBeforeAccept;
        steerChunksDelivered.resolve();
        await releaseSteeredQuery.promise;
        yield { type: 'done' };
        return;
      }
      if (options.partialBeforeGate) {
        yield { type: 'text', content: options.partialBeforeGate };
      }
      await options.gateByConversation?.get(conversationId);
      if (options.afterGateChunks) {
        yield* options.afterGateChunks;
        yield { type: 'done' };
        return;
      }
      if (options.approval && approvalCallback) {
        const decision = await approvalCallback(
          'command_execution',
          { command: 'test' },
          'Execute: test',
        );
        yield {
          type: 'text',
          content: decision === 'allow' ? 'approved' : 'denied',
        };
      } else if (options.userInput && askUserCallback && !userInputRequested) {
        userInputRequested = true;
        const answers = await askUserCallback(options.userInput);
        yield {
          type: 'text',
          content: JSON.stringify(answers),
        };
      } else if (!cancelled) {
        yield { type: 'text', content: `response:${conversationId}` };
      }
      yield { type: 'done' };
    },
    setApprovalCallback(callback: ApprovalCallback | null): void {
      approvalCallback = callback;
    },
    setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
      askUserCallback = callback;
    },
    buildSessionUpdates(): { updates: Partial<Conversation> } {
      return { updates: { sessionId: `session:${conversationId}` } };
    },
    consumeSessionInvalidation(): boolean {
      return false;
    },
    async setSessionTitle(title: string): Promise<void> {
      if (options.sessionTitleError) {
        throw options.sessionTitleError;
      }
      options.sessionTitles?.push(title);
    },
    cancel(): void {
      cancelled = true;
    },
    cleanup(): void {},
  };
  if (options.steerAccepted !== undefined || options.steerError) {
    Object.assign(runtime, {
      async steer(turn: PreparedChatTurn): Promise<boolean> {
        options.steeredRequests?.push(structuredClone(turn.request));
        if (options.steerError) {
          throw options.steerError;
        }
        if (options.steerChunksBeforeAccept) {
          steerStarted.resolve();
          await steerChunksDelivered.promise;
          setImmediate(releaseSteeredQuery.resolve);
        }
        await options.steerGate;
        return options.steerAccepted ?? false;
      },
    });
  }
  return runtime as unknown as ChatRuntime;
}

const host = {} as ProviderHost;

describe('RuntimeCoordinator', () => {
  it('keeps a task running while another conversation completes', async () => {
    const gate = deferred();
    const conversations = new Map([
      ['a', conversation('a')],
      ['b', conversation('b')],
    ]);
    const store = new MemoryConversationStore(conversations);
    const coordinator = new RuntimeCoordinator(
      host,
      store,
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
      }),
    );

    const taskA = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await coordinator.getSnapshot('a')).status, 'running');
    assert.deepEqual(coordinator.getActivitySummary('a'), {
      status: 'running',
      badgeCount: 1,
      runningCount: 1,
      waitingApprovalCount: 0,
      waitingInputCount: 0,
      failedCount: 0,
      interruptedCount: 0,
    });

    await coordinator.send('b', 'second', 'B.md');
    assert.equal((await coordinator.getSnapshot('b')).status, 'completed');
    assert.equal((await coordinator.getSnapshot('a')).status, 'running');
    assert.equal(coordinator.getActivitySummary('b').status, 'running');

    gate.resolve();
    await taskA;
    assert.equal((await coordinator.getSnapshot('a')).status, 'completed');
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.messages.at(-1)?.content,
      'response:a',
    );
    assert.deepEqual(coordinator.getActivitySummary('b'), {
      status: 'completed',
      badgeCount: 0,
      runningCount: 0,
      waitingApprovalCount: 0,
      waitingInputCount: 0,
      failedCount: 0,
      interruptedCount: 0,
    });
  });

  it('persists the completed turn status and elapsed time', async () => {
    const gate = deferred();
    let now = 1_000;
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
      }),
      () => now,
    );

    const task = coordinator.send('a', 'measure this turn', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    now = 63_000;
    gate.resolve();
    await task;

    const assistant = (await coordinator.getSnapshot('a'))
      .conversation?.messages.at(-1);
    assert.equal(assistant?.turnStatus, 'completed');
    assert.equal(assistant?.durationSeconds, 62);
  });

  it('persists failed turns and closes unfinished tool activity', async () => {
    let firstClockRead = true;
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: [
          {
            type: 'tool_use',
            id: 'command-1',
            name: 'Bash',
            input: { command: 'npm test' },
          },
          { type: 'error', content: 'Provider failed' },
        ],
      }),
      () => {
        if (firstClockRead) {
          firstClockRead = false;
          return 1_000;
        }
        return 5_000;
      },
    );

    await coordinator.send('a', 'run the tests', 'A.md');

    const snapshot = await coordinator.getSnapshot('a');
    const assistant = snapshot.conversation?.messages.at(-1);
    assert.equal(snapshot.status, 'failed');
    assert.equal(assistant?.turnStatus, 'failed');
    assert.equal(assistant?.durationSeconds, 4);
    assert.equal(assistant?.toolCalls?.[0]?.status, 'error');
  });

  it('pauses a task for approval and resumes after the decision', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({ approval: true }),
    );

    const task = coordinator.send('a', 'run command', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    const waiting = await coordinator.getSnapshot('a');
    assert.equal(waiting.status, 'waiting-approval');
    assert.equal(waiting.pendingApproval?.toolName, 'command_execution');
    assert.deepEqual(coordinator.getActivitySummary('a'), {
      status: 'waiting-approval',
      badgeCount: 1,
      runningCount: 1,
      waitingApprovalCount: 1,
      waitingInputCount: 0,
      failedCount: 0,
      interruptedCount: 0,
    });

    coordinator.respondToApproval('a', 'allow' satisfies ApprovalDecision);
    await task;
    const completed = await coordinator.getSnapshot('a');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.conversation?.messages.at(-1)?.content, 'approved');
  });

  it('upserts repeated tool use events and completes one tool card', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: [
          {
            type: 'tool_use',
            id: 'patch-1',
            name: 'apply_patch',
            input: { patch: 'first' },
          },
          {
            type: 'tool_use',
            id: 'patch-1',
            name: 'apply_patch',
            input: { patch: 'latest' },
          },
          {
            type: 'tool_result',
            id: 'patch-1',
            content: 'updated A.md',
            isError: false,
          },
        ],
      }),
    );

    await coordinator.send('a', 'update the page', 'A.md');
    const assistant = (await coordinator.getSnapshot('a'))
      .conversation?.messages.at(-1);

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
    ]);
  });

  it('coalesces adjacent streaming deltas without losing content order', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: [
          { type: 'text', content: 'Hel' },
          { type: 'text', content: 'lo' },
          { type: 'thinking', content: 'Inspecting ' },
          { type: 'thinking', content: 'the result.' },
          { type: 'text', content: ' world' },
        ],
      }),
    );

    await coordinator.send('a', 'stream', 'A.md');
    const assistant = (await coordinator.getSnapshot('a'))
      .conversation?.messages.at(-1);

    assert.equal(assistant?.content, 'Hello world');
    assert.deepEqual(assistant?.contentBlocks, [
      { type: 'text', content: 'Hello' },
      { type: 'thinking', content: 'Inspecting the result.' },
      { type: 'text', content: ' world' },
    ]);
  });

  it('stores commentary in order without mixing it into the final answer', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: [
          {
            type: 'text',
            content: 'I will inspect the renderer.',
            phase: 'commentary',
            itemId: 'commentary-1',
          },
          {
            type: 'tool_use',
            id: 'command-1',
            name: 'Bash',
            input: { command: 'npm test' },
          },
          {
            type: 'tool_result',
            id: 'command-1',
            content: 'passed',
          },
          {
            type: 'text',
            content: 'Implemented.',
            phase: 'final_answer',
            itemId: 'final-1',
          },
        ],
      }),
    );

    await coordinator.send('a', 'stream phases', 'A.md');
    const assistant = (await coordinator.getSnapshot('a'))
      .conversation?.messages.at(-1);

    assert.equal(assistant?.content, 'Implemented.');
    assert.deepEqual(assistant?.contentBlocks, [
      {
        type: 'text',
        content: 'I will inspect the renderer.',
        phase: 'commentary',
        itemId: 'commentary-1',
      },
      { type: 'tool_use', toolId: 'command-1' },
      {
        type: 'text',
        content: 'Implemented.',
        phase: 'final_answer',
        itemId: 'final-1',
      },
    ]);
  });

  it('coalesces progress snapshots instead of emitting once per delta', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: Array.from(
          { length: 500 },
          () => ({ type: 'text', content: 'x' } as StreamChunk),
        ),
      }),
    );
    let updates = 0;
    coordinator.onChange(() => {
      updates += 1;
    });

    await coordinator.send('a', 'stream heavily', 'A.md');

    assert.ok(updates <= 5, `expected at most 5 snapshots, received ${updates}`);
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.messages.at(-1)?.content.length,
      500,
    );
  });

  it('finishes a large bursty stream without a local completion backlog', async () => {
    const existing = conversation('a');
    existing.messages = Array.from({ length: 96 }, (_, index) => ({
      id: `history-${index}`,
      role: 'assistant' as const,
      content: 'h'.repeat(32_768),
      timestamp: index + 1,
    }));
    const conversations = new Map([['a', existing]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        scriptedChunks: Array.from(
          { length: 1_500 },
          () => ({ type: 'text', content: 'x' } as StreamChunk),
        ),
      }),
    );
    let updates = 0;
    coordinator.onChange(() => {
      updates += 1;
    });

    const startedAt = performance.now();
    await coordinator.send('a', 'large stream', 'A.md');
    const elapsedMs = performance.now() - startedAt;

    assert.ok(updates <= 5, `expected at most 5 snapshots, received ${updates}`);
    assert.ok(
      elapsedMs < 1_000,
      `expected local completion below 1 second, received ${elapsedMs.toFixed(1)}ms`,
    );
  });

  it('does not block stream completion on an in-progress checkpoint write', async () => {
    const gate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    let saveCount = 0;
    const store: ConversationStore = {
      async load(conversationId): Promise<Conversation | null> {
        const value = conversations.get(conversationId);
        return value ? structuredClone(value) : null;
      },
      async save(value): Promise<void> {
        saveCount += 1;
        if (saveCount === 2) {
          await gate.promise;
          return;
        }
        conversations.set(value.id, structuredClone(value));
      },
    };
    const coordinator = new RuntimeCoordinator(
      host,
      store,
      () => createFakeRuntime({
        scriptedChunks: [{ type: 'text', content: 'done' }],
      }),
    );

    const send = coordinator.send('a', 'checkpoint', 'A.md');
    const result = await Promise.race([
      send.then(() => 'completed'),
      new Promise<'timed-out'>(resolve => {
        setTimeout(() => resolve('timed-out'), 50);
      }),
    ]);
    gate.resolve();
    await send;

    assert.equal(result, 'completed');
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.messages.at(-1)?.turnStatus,
      'completed',
    );
  });

  it('waits for user input and resumes with the submitted answers', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        userInput: {
          questions: [{
            id: 'scope',
            header: 'Scope',
            question: 'Which scope should Windy use?',
            options: [
              { label: 'Current page', description: 'Only edit the active page.' },
              { label: 'Vault', description: 'Allow related pages.' },
            ],
            isOther: true,
            isSecret: false,
          }],
        },
      }),
    );

    const task = coordinator.send('a', 'ask me first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    const waiting = await coordinator.getSnapshot('a');

    assert.equal(waiting.status, 'waiting-input');
    assert.equal(waiting.pendingUserInput?.questions[0]?.id, 'scope');
    assert.equal(waiting.pendingUserInput?.questions[0]?.options.length, 2);
    assert.deepEqual(coordinator.getActivitySummary('a'), {
      status: 'waiting-input',
      badgeCount: 1,
      runningCount: 1,
      waitingApprovalCount: 0,
      waitingInputCount: 1,
      failedCount: 0,
      interruptedCount: 0,
    });
    await coordinator.send('a', 'second turn', 'A.md');
    assert.deepEqual(
      (await coordinator.getSnapshot('a')).conversation?.queuedTurns?.map(
        turn => turn.content,
      ),
      ['second turn'],
    );
    await assert.rejects(
      coordinator.setModel('a', 'another-model'),
      /Cannot change the model/,
    );

    coordinator.respondToUserInput('a', { scope: 'Current page' });
    await task;

    const completed = await coordinator.getSnapshot('a');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.pendingUserInput, null);
    assert.deepEqual(
      completed.conversation?.messages.map(message => message.content),
      [
        'ask me first',
        '{"scope":"Current page"}',
        'second turn',
        'response:a',
      ],
    );
  });

  it('queues concurrent turns and drains them in FIFO order', async () => {
    const gate = deferred();
    const preparedRequests: ChatTurnRequest[] = [];
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
        preparedRequests,
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'second', 'A.md');
    await coordinator.send('a', 'third', 'A.md');

    const queued = await coordinator.getSnapshot('a');
    assert.deepEqual(
      queued.conversation?.queuedTurns?.map(turn => turn.content),
      ['second', 'third'],
    );
    const secondTurnId = queued.conversation?.queuedTurns?.[0]?.id;
    assert.ok(secondTurnId);
    await coordinator.cancelQueuedTurn('a', secondTurnId);
    assert.deepEqual(
      (await coordinator.getSnapshot('a')).conversation?.queuedTurns?.map(
        turn => turn.content,
      ),
      ['third'],
    );

    gate.resolve();
    await first;

    const completed = await coordinator.getSnapshot('a');
    assert.deepEqual(
      preparedRequests.map(request => request.text),
      ['first', 'third'],
    );
    assert.deepEqual(
      completed.conversation?.messages.map(message => message.content),
      [
        'first',
        'response:a',
        'third',
        'response:a',
      ],
    );
    assert.deepEqual(completed.conversation?.queuedTurns, []);
  });

  it('keeps a queued turn when undo persistence fails', async () => {
    const gate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    const store = new MemoryConversationStore(conversations);
    const coordinator = new RuntimeCoordinator(
      host,
      store,
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'second', 'A.md');
    const queuedTurnId = (await coordinator.getSnapshot('a'))
      .conversation?.queuedTurns?.[0]?.id;
    assert.ok(queuedTurnId);

    store.rejectNextSave();
    await assert.rejects(
      coordinator.cancelQueuedTurn('a', queuedTurnId),
      /save failed/,
    );
    assert.deepEqual(
      (await coordinator.getSnapshot('a')).conversation?.queuedTurns?.map(
        turn => turn.content,
      ),
      ['second'],
    );

    gate.resolve();
    await first;
  });

  it('steers one queued turn exactly once and removes it from the FIFO', async () => {
    const steeredRequests: ChatTurnRequest[] = [];
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        steeredRequests,
        steerAccepted: true,
        steerChunksBeforeAccept: [
          {
            type: 'user_message_start',
            itemId: 'steered-user',
            content: 'urgent correction',
          },
          {
            type: 'assistant_message_start',
            itemId: 'assistant-after-steer',
            phase: 'final_answer',
          },
          {
            type: 'text',
            content: 'response after steering',
            itemId: 'assistant-after-steer',
            phase: 'final_answer',
          },
        ],
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'urgent correction', 'A.md');
    const queuedTurn = (await coordinator.getSnapshot('a'))
      .conversation?.queuedTurns?.[0];
    assert.ok(queuedTurn);

    await coordinator.steerQueuedTurn('a', queuedTurn.id);
    await assert.rejects(
      coordinator.steerQueuedTurn('a', queuedTurn.id),
      /no longer queued/,
    );

    const steered = await coordinator.getSnapshot('a');
    assert.deepEqual(steered.conversation?.queuedTurns, []);
    assert.equal(steeredRequests.length, 1);
    assert.equal(steeredRequests[0]?.text, 'urgent correction');
    const interrupt = steered.conversation?.messages.find(
      message => message.isInterrupt,
    );
    assert.equal(
      interrupt?.content,
      'urgent correction',
    );
    assert.equal(interrupt?.isInterrupt, true);

    await first;
    assert.equal(steeredRequests.length, 1);
    assert.deepEqual(
      (await coordinator.getSnapshot('a')).conversation?.messages.map(
        message => [message.role, message.content],
      ),
      [
        ['user', 'first'],
        ['assistant', ''],
        ['user', 'urgent correction'],
        ['assistant', 'response after steering'],
      ],
    );
  });

  it('does not undo a queued turn while provider steering is in flight', async () => {
    const queryGate = deferred();
    const steerGate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', queryGate.promise]]),
        steerAccepted: true,
        steerGate: steerGate.promise,
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'urgent correction', 'A.md');
    const queuedTurnId = (await coordinator.getSnapshot('a'))
      .conversation?.queuedTurns?.[0]?.id;
    assert.ok(queuedTurnId);

    const steering = coordinator.steerQueuedTurn('a', queuedTurnId);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      coordinator.cancelQueuedTurn('a', queuedTurnId),
      /cannot be undone while it is being steered/,
    );

    steerGate.resolve();
    await steering;
    queryGate.resolve();
    await first;
  });

  it('keeps a queued turn when the provider cannot accept steering', async () => {
    const gate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
        steerAccepted: false,
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'keep queued', 'A.md');
    const queuedTurn = (await coordinator.getSnapshot('a'))
      .conversation?.queuedTurns?.[0];
    assert.ok(queuedTurn);

    await assert.rejects(
      coordinator.steerQueuedTurn('a', queuedTurn.id),
      /could not steer/,
    );
    assert.deepEqual(
      (await coordinator.getSnapshot('a')).conversation?.queuedTurns?.map(
        turn => turn.content,
      ),
      ['keep queued'],
    );

    gate.resolve();
    await first;
  });

  it('clears in-flight steering state when the provider request fails', async () => {
    const gate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
        steerError: new Error('steer unavailable'),
      }),
    );

    const first = coordinator.send('a', 'first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'keep queued', 'A.md');
    const queuedTurn = (await coordinator.getSnapshot('a'))
      .conversation?.queuedTurns?.[0];
    assert.ok(queuedTurn);

    await assert.rejects(
      coordinator.steerQueuedTurn('a', queuedTurn.id),
      /steer unavailable/,
    );
    const snapshot = await coordinator.getSnapshot('a');
    assert.deepEqual(snapshot.steeringQueuedTurnIds, []);
    assert.deepEqual(
      snapshot.conversation?.queuedTurns?.map(turn => turn.content),
      ['keep queued'],
    );

    gate.resolve();
    await first;
  });

  it('cancels cleanly while waiting for user input', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        userInput: {
          questions: [{
            id: 'confirm',
            header: 'Confirm',
            question: 'Continue?',
            options: [{ label: 'Yes', description: '' }],
          }],
        },
      }),
    );

    const task = coordinator.send('a', 'ask me first', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    coordinator.cancel('a');
    await task;

    const cancelled = await coordinator.getSnapshot('a');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.pendingUserInput, null);
    assert.equal(cancelled.conversation?.activeTurn, undefined);
  });

  it('persists cancellation status and elapsed time', async () => {
    const gate = deferred();
    let now = 2_000;
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
      }),
      () => now,
    );

    const task = coordinator.send('a', 'cancel this turn', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    now = 12_000;
    coordinator.cancel('a');
    gate.resolve();
    await task;

    const assistant = (await coordinator.getSnapshot('a'))
      .conversation?.messages.at(-1);
    assert.equal(assistant?.turnStatus, 'cancelled');
    assert.equal(assistant?.durationSeconds, 10);
  });

  it('recovers persisted running output as interrupted and retries non-destructively', async () => {
    const gate = deferred();
    const sourceConversations = new Map([['a', conversation('a')]]);
    const sourceCoordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(sourceConversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
        partialBeforeGate: 'partial response',
      }),
    );

    const sourceTask = sourceCoordinator.send('a', 'original request', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    const persisted = structuredClone(sourceConversations.get('a')!);
    assert.equal(persisted.activeTurn?.status, 'running');
    assert.equal(persisted.messages.at(-1)?.content, 'partial response');
    assert.equal(persisted.sessionId, 'session:a');
    persisted.messages.at(-1)!.toolCalls = [{
      id: 'tool-1',
      name: 'command_execution',
      input: {},
      status: 'running',
    }];
    persisted.queuedTurns = [{
      id: 'queued-after-recovery',
      content: 'queued follow-up',
      primaryPagePath: 'A.md',
      createdAt: 200,
    }];

    const recoveredConversations = new Map([['a', persisted]]);
    const recoveredCoordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(recoveredConversations),
      () => createFakeRuntime({}),
      () => 500,
    );
    const interrupted = await recoveredCoordinator.getSnapshot('a');
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.conversation?.activeTurn?.status, 'interrupted');
    assert.equal(interrupted.conversation?.messages.at(-1)?.content, 'partial response');
    assert.equal(interrupted.conversation?.messages.at(-1)?.interruptedAt, 500);
    assert.equal(
      interrupted.conversation?.messages.at(-1)?.turnStatus,
      'interrupted',
    );
    assert.equal(
      interrupted.conversation?.messages.at(-1)?.toolCalls?.[0]?.status,
      'blocked',
    );
    assert.deepEqual(recoveredCoordinator.getActivitySummary('a'), {
      status: 'interrupted',
      badgeCount: 1,
      runningCount: 0,
      waitingApprovalCount: 0,
      waitingInputCount: 0,
      failedCount: 0,
      interruptedCount: 1,
    });

    await recoveredCoordinator.retryInterrupted('a');
    const retried = await recoveredCoordinator.getSnapshot('a');
    assert.equal(retried.status, 'completed');
    assert.equal(retried.conversation?.messages.length, 6);
    assert.deepEqual(
      retried.conversation?.messages.slice(-4).map(message => message.content),
      [
        'original request',
        'response:a',
        'queued follow-up',
        'response:a',
      ],
    );
    assert.equal(retried.conversation?.messages.at(-1)?.content, 'response:a');
    assert.deepEqual(retried.conversation?.queuedTurns, []);
    assert.equal(retried.conversation?.activeTurn, undefined);

    gate.resolve();
    await sourceTask;
  });

  it('continues an interrupted turn on the same conversation with explicit display text', async () => {
    const interrupted = conversation('a');
    interrupted.messages = [
      {
        id: 'user-1',
        role: 'user',
        content: 'long task',
        timestamp: 10,
        primaryPagePath: 'A.md',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'partial',
        timestamp: 10,
      },
    ];
    interrupted.activeTurn = {
      status: 'interrupted',
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      primaryPagePath: 'A.md',
      startedAt: 10,
      updatedAt: 20,
      interruptedAt: 20,
    };
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(new Map([['a', interrupted]])),
      () => createFakeRuntime({}),
    );

    await coordinator.continueInterrupted('a', 'A.md');

    const completed = await coordinator.getSnapshot('a');
    const continuation = completed.conversation?.messages.at(-2);
    assert.equal(completed.status, 'completed');
    assert.equal(continuation?.displayContent, 'Continue');
    assert.match(continuation?.content ?? '', /Continue from where/);
    assert.equal(completed.conversation?.sessionId, 'session:a');
  });

  it('persists interruption during normal plugin cleanup', async () => {
    const gate = deferred();
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        gateByConversation: new Map([['a', gate.promise]]),
        partialBeforeGate: 'saved before cleanup',
      }),
    );

    const task = coordinator.send('a', 'work', 'A.md');
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.send('a', 'run after restart', 'A.md');
    coordinator.cleanup();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(conversations.get('a')?.activeTurn?.status, 'interrupted');
    assert.equal(
      conversations.get('a')?.messages.at(-1)?.content,
      'saved before cleanup',
    );
    assert.deepEqual(
      conversations.get('a')?.queuedTurns?.map(turn => turn.content),
      ['run after restart'],
    );

    gate.resolve();
    await task;
    assert.equal(conversations.get('a')?.activeTurn?.status, 'interrupted');
    assert.deepEqual(
      conversations.get('a')?.queuedTurns?.map(turn => turn.content),
      ['run after restart'],
    );
  });

  it('deduplicates concurrent initialization for the same conversation', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const gate = deferred();
    let loadCount = 0;
    let runtimeCount = 0;
    const store: ConversationStore = {
      async load(conversationId: string): Promise<Conversation | null> {
        loadCount += 1;
        await gate.promise;
        const loaded = conversations.get(conversationId);
        return loaded ? structuredClone(loaded) : null;
      },
      async save(saved: Conversation): Promise<void> {
        conversations.set(saved.id, structuredClone(saved));
      },
    };
    const coordinator = new RuntimeCoordinator(host, store, () => {
      runtimeCount += 1;
      return createFakeRuntime({});
    });

    const snapshots = Promise.all([
      coordinator.getSnapshot('a'),
      coordinator.getSnapshot('a'),
    ]);
    gate.resolve();
    const [first, second] = await snapshots;

    assert.equal(first.conversation?.id, 'a');
    assert.equal(second.conversation?.id, 'a');
    assert.equal(loadCount, 1);
    assert.equal(runtimeCount, 1);
  });

  it('persists conversation model selection and clears it for Auto', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({}),
    );

    await coordinator.setModel('a', 'gpt-5.6-terra');
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.selectedModel,
      'gpt-5.6-terra',
    );

    await coordinator.setModel('a', undefined);
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.selectedModel,
      undefined,
    );
  });

  it('persists and forwards the conversation reasoning effort', async () => {
    const queryOptions: ChatRuntimeQueryOptions[] = [];
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({ queryOptions }),
    );

    await coordinator.setReasoningEffort('a', 'high');
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.selectedReasoningEffort,
      'high',
    );

    await coordinator.send('a', 'test', 'A.md');
    assert.deepEqual(queryOptions, [{
      model: 'test-model',
      reasoningEffort: 'high',
    }]);

    await coordinator.setModel('a', 'another-model');
    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.selectedReasoningEffort,
      undefined,
    );
  });

  it('stores a concrete model and reasoning effort in one selection update', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({}),
    );

    await coordinator.setSelection('a', 'gpt-5.6-sol', 'low');
    const snapshot = await coordinator.getSnapshot('a');
    assert.equal(snapshot.conversation?.selectedModel, 'gpt-5.6-sol');
    assert.equal(snapshot.conversation?.selectedReasoningEffort, 'low');
  });

  it('materializes only missing legacy selection fields', async () => {
    const legacy = conversation('a');
    legacy.selectedModel = 'legacy-model';
    const conversations = new Map([['a', legacy]]);
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({}),
    );

    await coordinator.materializeSelection('a', 'fallback-model', 'medium');
    const snapshot = await coordinator.getSnapshot('a');
    assert.equal(snapshot.conversation?.selectedModel, 'legacy-model');
    assert.equal(snapshot.conversation?.selectedReasoningEffort, 'medium');
  });

  it('names a new conversation from its first request', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    conversations.get('a')!.title = 'New conversation';
    const sessionTitles: string[] = [];
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({ sessionTitles }),
    );

    await coordinator.send(
      'a',
      '  Explain\n the page conversation architecture  ',
      'A.md',
    );

    assert.equal(
      (await coordinator.getSnapshot('a')).conversation?.title,
      'Explain the page conversation architecture',
    );
    assert.deepEqual(sessionTitles, [
      'Explain the page conversation architecture',
    ]);
  });

  it('does not fail a completed turn when session title sync fails', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    conversations.get('a')!.title = 'New conversation';
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({
        sessionTitleError: new Error('title service unavailable'),
      }),
    );

    await coordinator.send('a', 'Keep the completed response', 'A.md');

    const snapshot = await coordinator.getSnapshot('a');
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.conversation?.messages.at(-1)?.content, 'response:a');
  });

  it('persists and forwards additional page references with the turn', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    const preparedRequests: ChatTurnRequest[] = [];
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({ preparedRequests }),
    );

    await coordinator.send(
      'a',
      'Compare the pages',
      'A.md',
      ['B.md', 'Folder/C.base'],
    );

    const snapshot = await coordinator.getSnapshot('a');
    assert.deepEqual(
      snapshot.conversation?.messages.at(-2)?.referencedPagePaths,
      ['B.md', 'Folder/C.base'],
    );
    assert.deepEqual(preparedRequests[0].referencedPagePaths, [
      'B.md',
      'Folder/C.base',
    ]);
  });

  it('persists and forwards local file attachments with the turn', async () => {
    const conversations = new Map([['a', conversation('a')]]);
    conversations.get('a')!.title = 'New conversation';
    const preparedRequests: ChatTurnRequest[] = [];
    const coordinator = new RuntimeCoordinator(
      host,
      new MemoryConversationStore(conversations),
      () => createFakeRuntime({ preparedRequests }),
    );
    const attachments = [{
      id: 'file-1',
      name: 'report.pdf',
      path: '/tmp/report.pdf',
      location: 'external' as const,
      mediaType: 'application/pdf',
      size: 1024,
      source: 'drop' as const,
    }];

    await coordinator.send('a', '', 'A.md', [], attachments);

    const snapshot = await coordinator.getSnapshot('a');
    assert.deepEqual(
      snapshot.conversation?.messages.at(-2)?.attachments,
      attachments,
    );
    assert.deepEqual(preparedRequests[0].attachments, attachments);
    assert.equal(snapshot.conversation?.title, 'report.pdf');
  });
});
