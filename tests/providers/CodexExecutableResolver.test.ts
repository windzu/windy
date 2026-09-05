import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findDesktopCodex,
  formatCodexRuntimeError,
  resolveCodexExecutable,
} from '../../src/providers/codex/runtime/CodexExecutableResolver';

const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex';
const options = {
  platform: 'darwin' as const,
  homeDirectory: '/test-user',
  isExecutable: (candidate: string) => candidate === bundled,
};

test('prefers the desktop app over the command found through PATH', () => {
  assert.equal(resolveCodexExecutable(options), bundled);
});

test('supports Codex.app and user-local application installations', () => {
  for (const candidate of [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/test-user/Applications/ChatGPT.app/Contents/Resources/codex',
    '/test-user/Applications/Codex.app/Contents/Resources/codex',
  ]) {
    assert.equal(findDesktopCodex({
      ...options, isExecutable: value => value === candidate,
    }), candidate);
  }
});

test('honors explicit paths and never falls back from a broken pinned executable', () => {
  assert.equal(resolveCodexExecutable({
    ...options, cliPath: ' /custom/codex ', isExecutable: () => true,
  }), '/custom/codex');
  assert.throws(() => resolveCodexExecutable({
    ...options, cliPath: '/missing/codex',
  }), /configured Codex executable is unavailable/);
  assert.equal(resolveCodexExecutable({ ...options, cliPath: 'codex' }), 'codex');
});

test('keeps PATH fallback on hosts without a supported desktop app', () => {
  assert.equal(resolveCodexExecutable({ ...options, isExecutable: () => false }), 'codex');
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(resolveCodexExecutable({ ...options, platform }), 'codex');
  }
});

test('does not resolve WSL commands against the host filesystem', () => {
  const isExecutable = (): boolean => { throw new Error('must not inspect host'); };
  assert.equal(resolveCodexExecutable({
    ...options, isWsl: true, isExecutable,
  }), 'codex');
  assert.equal(resolveCodexExecutable({
    ...options, isWsl: true, cliPath: '/linux/codex', isExecutable,
  }), '/linux/codex');
});

test('explains incompatible history with the actual executable and version', () => {
  const message = formatCodexRuntimeError(
    new Error('paginated_threads is not supported yet'),
    '/old/codex', 'Codex/0.144.4',
  );
  assert.match(message, /\/old\/codex/);
  assert.match(message, /0\.144\.4/);
  assert.match(message, /reload Windy and retry/);
  assert.equal(formatCodexRuntimeError(new Error('network failed')), 'network failed');
});
