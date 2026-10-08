import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { App, EventRef, TFile } from 'obsidian';

import {
  PageAgentIndex,
  type PageAgentIndexDocument,
} from '../../src/page-context/PageAgentIndex';
import { PageContextResolver } from '../../src/page-context/PageContextResolver';
import { PageConversationRouter } from '../../src/page-context/PageConversationRouter';
import { JsonFileStore } from '../../src/storage/JsonFileStore';
import { MemoryJsonFileAdapter } from '../helpers/MemoryJsonFileAdapter';

class FakeWorkspace {
  private file: TFile | null = null;
  private listeners = new Map<EventRef, () => void>();

  getActiveFile(): TFile | null {
    return this.file;
  }

  on(_name: string, callback: () => void): EventRef {
    const ref = {} as EventRef;
    this.listeners.set(ref, callback);
    return ref;
  }

  offref(ref: EventRef): void {
    this.listeners.delete(ref);
  }

  open(path: string): void {
    this.setPath(path);
    for (const listener of this.listeners.values()) {
      listener();
    }
  }

  setPath(path: string): void {
    const filename = path.split('/').at(-1)!;
    const extension = filename.split('.').at(-1)!;
    const fields = {
      path,
      basename: filename.slice(0, -(extension.length + 1)),
      extension,
    };
    if (this.file) {
      Object.assign(this.file, fields);
    } else {
      this.file = fields as TFile;
    }
  }
}

async function setup() {
  const adapter = new MemoryJsonFileAdapter();
  const store = new JsonFileStore<PageAgentIndexDocument>(
    adapter,
    '.windy/page-agent-index.json',
  );
  const index = new PageAgentIndex(store);
  await index.initialize();
  const workspace = new FakeWorkspace();
  const context = new PageContextResolver({ workspace } as unknown as App);
  const router = new PageConversationRouter(context, index);
  context.start();
  router.start();
  return { adapter, store, index, workspace, context, router };
}

describe('Page rename routing', () => {
  it('refreshes a renamed active page without a workspace navigation event', async () => {
    const { index, workspace, context, router } = await setup();
    workspace.open('Notes/Original.md');
    await router.associateConversation('first');
    await router.associateConversation('second');
    await router.selectConversation('first');

    workspace.setPath('Notes/Renamed.md');
    await index.migratePath('Notes/Original.md', 'Notes/Renamed.md');
    router.refresh();

    assert.deepEqual(context.getActivePage(), {
      path: 'Notes/Renamed.md',
      basename: 'Renamed',
      extension: 'md',
    });
    assert.equal(router.getRoute().activeConversationId, 'first');
    assert.deepEqual(router.getRoute().conversationIds, ['first', 'second']);
  });

  it('keeps the conversation visible while rename persistence is pending', async () => {
    const { adapter, workspace, router } = await setup();
    workspace.open('Original.md');
    await router.associateConversation('running');
    let releaseSave = (): void => undefined;
    const saveGate = new Promise<void>(resolve => {
      releaseSave = resolve;
    });
    const process = adapter.process.bind(adapter);
    adapter.process = async (path, update) => {
      await saveGate;
      return process(path, update);
    };
    const publishedIds: Array<string | null> = [];
    router.onChange(route => publishedIds.push(route.activeConversationId));

    workspace.setPath('Renamed.md');
    const migration = router.migratePagePath('Original.md', 'Renamed.md');
    try {
      assert.equal(router.getRoute().page?.path, 'Renamed.md');
      assert.equal(router.getRoute().activeConversationId, 'running');
      assert.deepEqual(publishedIds, ['running']);
    } finally {
      releaseSave();
      await migration;
    }
  });

  for (const extension of ['md', 'base']) {
    it(`restores all ${extension} page conversations after repeated renames and restart`, async () => {
      const { store, index, workspace, context, router } = await setup();
      workspace.open(`Notes/Original.${extension}`);
      await router.associateConversation('first');
      await router.associateConversation('second');
      await router.selectConversation('first');

      for (const [oldName, newName] of [
        ['Original', 'Renamed'],
        ['Renamed', 'Final'],
      ]) {
        const oldPath = `Notes/${oldName}.${extension}`;
        const newPath = `Notes/${newName}.${extension}`;
        workspace.setPath(newPath);
        await router.migratePagePath(oldPath, newPath);
        assert.equal(index.get(oldPath), null);
        assert.equal(router.getRoute().page?.path, newPath);
        assert.equal(router.getRoute().activeConversationId, 'first');
        assert.deepEqual(router.getRoute().conversationIds, ['first', 'second']);
      }

      router.stop();
      context.stop();
      const restoredIndex = new PageAgentIndex(store);
      await restoredIndex.initialize();
      const restoredContext = new PageContextResolver({ workspace } as unknown as App);
      const restoredRouter = new PageConversationRouter(restoredContext, restoredIndex);
      restoredContext.start();
      restoredRouter.start();
      assert.equal(restoredRouter.getRoute().page?.path, `Notes/Final.${extension}`);
      assert.equal(restoredRouter.getRoute().activeConversationId, 'first');
      assert.deepEqual(restoredRouter.getRoute().conversationIds, ['first', 'second']);

      workspace.open(`Notes/Original.${extension}`);
      assert.equal(restoredRouter.getRoute().activeConversationId, null);
    });
  }

  it('moves a folder and its nested page associations without changing other pages', async () => {
    const { index, workspace, router } = await setup();
    workspace.open('Projects/Alpha.md');
    await router.associateConversation('alpha');
    await index.associate('Projects/Nested/Beta.base', 'beta');
    await index.associate('Projects-other/Untouched.md', 'untouched');

    workspace.setPath('Archive/Alpha.md');
    await router.migratePagePath('Projects', 'Archive');
    assert.equal(router.getRoute().page?.path, 'Archive/Alpha.md');
    assert.equal(router.getRoute().activeConversationId, 'alpha');
    assert.equal(index.get('Archive/Nested/Beta.base')?.activeConversationId, 'beta');
    assert.equal(index.get('Projects/Nested/Beta.base'), null);
    assert.equal(index.get('Projects-other/Untouched.md')?.activeConversationId, 'untouched');
  });

  it('renames an inactive page without switching the visible conversation', async () => {
    const { index, workspace, router } = await setup();
    workspace.open('Original.md');
    await router.associateConversation('original');
    workspace.open('Other.md');
    await router.associateConversation('other');

    await router.migratePagePath('Original.md', 'Renamed.md');
    assert.equal(router.getRoute().page?.path, 'Other.md');
    assert.equal(router.getRoute().activeConversationId, 'other');
    assert.equal(index.get('Original.md'), null);

    workspace.open('Renamed.md');
    assert.equal(router.getRoute().activeConversationId, 'original');
  });
});
