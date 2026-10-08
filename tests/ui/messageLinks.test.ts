import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  handleMessageLinkClick,
  resolveMessageLink,
  type MessageLinkContext,
  type MessageLinkNavigator,
} from '../../src/ui/messageLinks';

const context: MessageLinkContext = {
  sourcePath: 'Projects/Overview.md',
  vaultName: 'Test Vault',
  vaultPath: '/test/Test Vault',
};

describe('message link navigation', () => {
  it('preserves wiki link destinations, headings, blocks, and literal percent escapes', () => {
    for (const link of ['Plans/Next#Scope', 'Plans/Next#^task', '100%20ready']) {
      assert.deepEqual(resolveMessageLink({ href: 'Alias', dataHref: link }, context), {
        type: 'internal',
        linkText: link,
      });
    }
  });

  it('decodes Markdown paths while leaving resolution relative to the conversation page', () => {
    for (const [href, linkText] of [
      ['../Plans/Next%20step.md#%E9%AA%8C%E6%94%B6', '../Plans/Next step.md#验收'],
      ['#%5Etask', '#^task'],
      ['Projects.base', 'Projects.base'],
      ['Notes/100% complete.md', 'Notes/100% complete.md'],
    ]) {
      assert.deepEqual(resolveMessageLink({ href }, context), { type: 'internal', linkText });
    }
  });

  it('opens absolute paths and file URIs inside the vault as Obsidian links', () => {
    for (const href of [
      '/test/Test%20Vault/Plans/Next%20step.md#Scope',
      'file:///test/Test%20Vault/Plans/Next%20step.md#Scope',
      'app://obsidian.md/Plans/Next%20step.md#Scope',
    ]) {
      assert.deepEqual(resolveMessageLink({ href }, context), {
        type: 'internal',
        linkText: 'Plans/Next step.md#Scope',
      });
    }
    assert.deepEqual(resolveMessageLink({
      href: 'file:///test/Test%20Vault-other/Next.md',
    }, context), {
      type: 'external',
      url: 'file:///test/Test%20Vault-other/Next.md',
    });
  });

  it('opens current-vault Obsidian URIs internally and decodes them only once', () => {
    for (const href of [
      'obsidian://open?vault=Test%20Vault&file=Plans%2FNext%23%5Etask',
      'obsidian://open?file=Plans%2FNext%23%5Etask',
      'obsidian://open?path=%2Ftest%2FTest%20Vault%2FPlans%2FNext%23%5Etask&vault=Other',
    ]) {
      assert.deepEqual(resolveMessageLink({ href }, context), {
        type: 'internal',
        linkText: 'Plans/Next#^task',
      });
    }
    assert.deepEqual(resolveMessageLink({
      href: 'obsidian://open?file=100%2520ready',
    }, context), { type: 'internal', linkText: '100%20ready' });
  });

  it('requests a popout when an Obsidian URI targets another vault or vault ID', () => {
    const target = resolveMessageLink({
      href: 'obsidian://open?vault=other-vault&file=Plan&paneType=tab',
    }, context);
    assert.equal(target?.type, 'external');
    if (target?.type === 'external') {
      const uri = new URL(target.url);
      assert.equal(uri.searchParams.get('vault'), 'other-vault');
      assert.equal(uri.searchParams.get('file'), 'Plan');
      assert.equal(uri.searchParams.get('paneType'), 'window');
    }
  });

  it('preserves web, email, application, and non-navigation Obsidian URIs', () => {
    for (const url of [
      'https://example.com/search?q=Next%20step#results',
      'mailto:hello@example.com',
      'zotero://select/items/123',
      'obsidian://search?vault=Test%20Vault&query=Plan',
    ]) {
      assert.deepEqual(resolveMessageLink({ href: url }, context), { type: 'external', url });
    }
    assert.deepEqual(resolveMessageLink({ href: '//example.com/docs' }, context), {
      type: 'external', url: 'https://example.com/docs',
    });
  });

  it('does not navigate empty or executable links', () => {
    for (const href of ['', '  ', 'javascript:alert(1)', 'DATA:text/html,test', 'vbscript:test']) {
      assert.equal(resolveMessageLink({ href }, context), null);
    }
  });

  it('opens nested or keyboard-activated links once in a new window using the source page', () => {
    const harness = clickHarness('Plans/Next#Scope');
    handleMessageLinkClick(harness.event, harness.container, context, harness.navigator);

    assert.deepEqual(harness.opened, [['Plans/Next#Scope', 'Projects/Overview.md', 'window']]);
    assert.equal(harness.prevented, true);
    assert.equal(harness.stopped, true);
  });

  it('handles middle clicks and external links without also triggering native navigation', () => {
    const harness = clickHarness('https://example.com', 1);
    handleMessageLinkClick(harness.event, harness.container, context, harness.navigator);
    assert.deepEqual(harness.opened, [['https://example.com']]);
    assert.equal(harness.prevented, true);
    assert.equal(harness.stopped, true);
  });

  it('leaves context menus, text selection, footnotes, and links outside the message alone', () => {
    for (const options of [
      { button: 2 },
      { anchor: false },
      { footnote: true },
      { contained: false },
    ]) {
      const harness = clickHarness('Plans/Next', options.button, options);
      handleMessageLinkClick(harness.event, harness.container, context, harness.navigator);
      assert.deepEqual(harness.opened, []);
      assert.equal(harness.prevented, false);
      assert.equal(harness.stopped, false);
    }
  });

  it('reports failed navigation without an unhandled rejection', async () => {
    const harness = clickHarness('Plans/Next');
    const failure = new Error('Cannot open window');
    harness.navigator.openInternal = async () => { throw failure; };
    handleMessageLinkClick(harness.event, harness.container, context, harness.navigator);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.errors, [failure]);
  });
});

function clickHarness(
  href: string,
  button = 0,
  options: { anchor?: boolean; footnote?: boolean; contained?: boolean } = {},
) {
  const opened: unknown[][] = [];
  const errors: unknown[] = [];
  const anchor = {
    getAttribute: (name: string) => name === 'href' ? href : null,
    matches: () => options.footnote === true,
  };
  const harness = {
    opened,
    errors,
    prevented: false,
    stopped: false,
    event: {
      button,
      target: {
        nodeType: 3,
        parentElement: { closest: () => options.anchor === false ? null : anchor },
      },
      preventDefault: () => { harness.prevented = true; },
      stopImmediatePropagation: () => { harness.stopped = true; },
    } as unknown as MouseEvent,
    container: { contains: () => options.contained !== false } as unknown as HTMLElement,
    navigator: {
      openInternal: async (...args) => { opened.push(args); },
      openExternal: url => { opened.push([url]); },
      onError: error => { errors.push(error); },
    } satisfies MessageLinkNavigator,
  };
  return harness;
}
