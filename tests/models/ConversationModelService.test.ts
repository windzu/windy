import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_WINDY_SETTINGS } from '../../src/app/settings';
import {
  CodexConversationModelService,
  type ConversationModelTarget,
  type ModelCatalogGateway,
} from '../../src/providers/codex/CodexConversationModelService';
import type {
  AppServerModel,
  ModelListResult,
} from '../../src/providers/codex/runtime/codexAppServerTypes';

function model(
  id: string,
  options: Partial<AppServerModel> = {},
): AppServerModel {
  return {
    id,
    model: id,
    displayName: id,
    description: `${id} description`,
    hidden: false,
    supportedReasoningEfforts: [
      {
        reasoningEffort: 'low',
        description: 'Faster responses',
      },
      {
        reasoningEffort: 'medium',
        description: 'Balanced reasoning',
      },
      {
        reasoningEffort: 'high',
        description: 'Deeper reasoning',
      },
    ],
    defaultReasoningEffort: 'medium',
    isDefault: false,
    ...options,
  };
}

describe('ConversationModelService', () => {
  it('shares concurrent paginated catalog loads and hides unavailable models', async () => {
    let readyCount = 0;
    let requestCount = 0;
    const gateway: ModelCatalogGateway = {
      async ensureReady(): Promise<void> {
        readyCount += 1;
      },
      async request<T>(
        _method: string,
        params: { cursor?: string },
      ): Promise<T> {
        requestCount += 1;
        const result: ModelListResult = params.cursor
          ? {
            data: [model('gpt-5.6-terra')],
            nextCursor: null,
          }
          : {
            data: [
              model('gpt-5.6-sol', { isDefault: true }),
              model('hidden-model', { hidden: true }),
            ],
            nextCursor: 'next',
          };
        return result as T;
      },
    };
    const target: ConversationModelTarget = {
      async setSelection(): Promise<void> {},
      async setReasoningEffort(): Promise<void> {},
    };
    const service = new CodexConversationModelService(
      gateway,
      target,
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    const [first, second] = await Promise.all([
      service.getOptions(),
      service.getOptions(),
    ]);

    assert.deepEqual(
      first.map(option => [option.value, option.label]),
      [
        ['gpt-5.6-sol', 'GPT-5.6 Sol'],
        ['gpt-5.6-terra', 'GPT-5.6 Terra'],
      ],
    );
    assert.deepEqual(
      first[0]?.reasoningEfforts.map(option => [
        option.value,
        option.label,
        option.isDefault,
      ]),
      [
        ['low', 'Low', false],
        ['medium', 'Medium', true],
        ['high', 'High', false],
      ],
    );
    assert.deepEqual(second, first);
    assert.equal(readyCount, 1);
    assert.equal(requestCount, 2);
    await service.getOptions();
    assert.equal(readyCount, 2);
    assert.equal(requestCount, 4);
  });

  it('discovers new models and defaults without reloading or changing existing selections', async () => {
    let catalog = [model('gpt-5.6-sol', { isDefault: true })];
    const updates: Array<[string, string, string]> = [];
    const service = new CodexConversationModelService(
      {
        async ensureReady(): Promise<void> {},
        async request<T>(): Promise<T> {
          return { data: catalog, nextCursor: null } as T;
        },
      },
      {
        async setSelection(conversationId, selectedModel, effort): Promise<void> {
          updates.push([conversationId, selectedModel, effort]);
        },
        async setReasoningEffort(): Promise<void> {},
      },
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    const first = await service.getOptions();
    first[0].label = 'Changed by caller';
    first[0].reasoningEfforts.length = 0;
    catalog = [
      model('gpt-6.1-sol', { isDefault: true, defaultReasoningEffort: 'low' }),
      model('gpt-5.6-sol'),
    ];

    const refreshed = await service.getOptions();
    assert.deepEqual(refreshed.map(option => option.value), [
      'gpt-6.1-sol', 'gpt-5.6-sol',
    ]);
    assert.equal(service.getSelectionLabel('gpt-6.1-sol'), 'GPT-6.1 Sol');
    assert.equal(service.getSelectionLabel('gpt-5.6-sol'), 'GPT-5.6 Sol');
    assert.deepEqual(await service.getNewConversationDefaults(), {
      model: 'gpt-6.1-sol', reasoningEffort: 'low',
    });
    assert.deepEqual(updates, []);
    await service.select('conversation-1', 'gpt-6.1-sol');
    assert.deepEqual(updates, [['conversation-1', 'gpt-6.1-sol', 'low']]);
  });

  it('keeps labels after a failed refresh and retries the next catalog request', async () => {
    let fail = false;
    let requests = 0;
    const service = new CodexConversationModelService(
      {
        async ensureReady(): Promise<void> {},
        async request<T>(): Promise<T> {
          requests += 1;
          if (fail) {
            throw new Error('catalog unavailable');
          }
          return { data: [model('gpt-6.1-sol')], nextCursor: null } as T;
        },
      },
      {
        async setSelection(): Promise<void> {},
        async setReasoningEffort(): Promise<void> {},
      },
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    await service.getOptions();
    fail = true;
    await assert.rejects(service.getOptions(), /catalog unavailable/);
    assert.equal(service.getSelectionLabel('gpt-6.1-sol'), 'GPT-6.1 Sol');
    fail = false;
    assert.equal((await service.getOptions())[0].value, 'gpt-6.1-sol');
    assert.equal(requests, 3);
  });

  it('persists a concrete model and its default effort atomically', async () => {
    const updates: Array<[string, string, string]> = [];
    const gateway: ModelCatalogGateway = {
      async ensureReady(): Promise<void> {},
      async request<T>(): Promise<T> {
        return {
          data: [model('gpt-5.6-terra')],
          nextCursor: null,
        } as T;
      },
    };
    const target: ConversationModelTarget = {
      async setSelection(
        conversationId: string,
        selectedModel: string,
        reasoningEffort: string,
      ): Promise<void> {
        updates.push([conversationId, selectedModel, reasoningEffort]);
      },
      async setReasoningEffort(): Promise<void> {},
    };
    const service = new CodexConversationModelService(
      gateway,
      target,
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    await service.select('conversation-1', 'gpt-5.6-terra');
    await service.select('conversation-1', null);

    assert.deepEqual(updates, [
      ['conversation-1', 'gpt-5.6-terra', 'medium'],
      ['conversation-1', 'gpt-5.6-terra', 'medium'],
    ]);
    await assert.rejects(
      service.select('conversation-1', 'missing'),
      /not available/,
    );
  });

  it('uses model-scoped reasoning efforts and persists an explicit selection', async () => {
    const updates: Array<[string, string | undefined]> = [];
    const service = new CodexConversationModelService(
      {
        async ensureReady(): Promise<void> {},
        async request<T>(): Promise<T> {
          return {
            data: [model('gpt-5.6-sol')],
            nextCursor: null,
          } as T;
        },
      },
      {
        async setSelection(): Promise<void> {},
        async setReasoningEffort(conversationId, reasoningEffort): Promise<void> {
          updates.push([conversationId, reasoningEffort]);
        },
      },
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    const efforts = await service.getReasoningOptions('gpt-5.6-sol');
    assert.deepEqual(efforts.map(option => option.value), [
      'low',
      'medium',
      'high',
    ]);
    assert.equal(
      service.getReasoningSelectionLabel('gpt-5.6-sol', undefined),
      'Medium',
    );

    await service.selectReasoningEffort('conversation-1', 'gpt-5.6-sol', 'high');
    await service.selectReasoningEffort('conversation-1', 'gpt-5.6-sol', null);

    assert.deepEqual(updates, [
      ['conversation-1', 'high'],
      ['conversation-1', 'medium'],
    ]);
    await assert.rejects(
      service.selectReasoningEffort('conversation-1', 'gpt-5.6-sol', 'xhigh'),
      /not available for this model/,
    );
  });

  it('resolves provider and model defaults from the live catalog', async () => {
    const service = new CodexConversationModelService(
      {
        async ensureReady(): Promise<void> {},
        async request<T>(): Promise<T> {
          return {
            data: [model('gpt-5.6-sol', {
              isDefault: true,
              defaultReasoningEffort: 'low',
            })],
            nextCursor: null,
          } as T;
        },
      },
      {
        async setSelection(): Promise<void> {},
        async setReasoningEffort(): Promise<void> {},
      },
      structuredClone(DEFAULT_WINDY_SETTINGS),
    );

    assert.deepEqual(await service.getNewConversationDefaults(), {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
    });
    assert.equal(service.getSelectionLabel(undefined), 'Loading…');
  });

  it('preserves legacy persisted defaults when materializing an old conversation', async () => {
    const settings = structuredClone(DEFAULT_WINDY_SETTINGS);
    settings.model = 'gpt-5.6-sol';
    settings.effortLevel = 'medium';
    const service = new CodexConversationModelService(
      {
        async ensureReady(): Promise<void> {},
        async request<T>(): Promise<T> {
          return {
            data: [model('gpt-5.6-sol', {
              isDefault: true,
              defaultReasoningEffort: 'low',
            })],
            nextCursor: null,
          } as T;
        },
      },
      {
        async setSelection(): Promise<void> {},
        async setReasoningEffort(): Promise<void> {},
      },
      settings,
    );

    assert.deepEqual(await service.getLegacyConversationDefaults(), {
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    });
  });
});
