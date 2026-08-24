import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(
  new URL('../../styles.css', import.meta.url),
  'utf8',
);

test('overlays the return control without changing transcript geometry', () => {
  const buttonRule = styles.match(
    /\.windy-view__back-to-latest\s*\{(?<declarations>[^}]*)\}/,
  );
  const hiddenRule = styles.match(
    /\.windy-view__back-to-latest\[hidden\]\s*\{(?<declarations>[^}]*)\}/,
  );
  const hoverRule = styles.match(
    /\.windy-view__back-to-latest:hover\s*\{(?<declarations>[^}]*)\}/,
  );
  const iconRule = styles.match(
    /\.windy-view__back-to-latest-icon\s*\{(?<declarations>[^}]*)\}/,
  );

  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /position:\s*absolute/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /background:\s*var\(--background-primary\)/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /border:\s*1px solid var\(--windy-accent\)/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /color:\s*var\(--text-normal\)/,
  );
  assert.match(
    hoverRule?.groups?.declarations ?? '',
    /background:\s*var\(--windy-accent-soft\)/,
  );
  assert.match(
    iconRule?.groups?.declarations ?? '',
    /color:\s*var\(--windy-accent\)/,
  );
  assert.match(
    hiddenRule?.groups?.declarations ?? '',
    /display:\s*none/,
  );
  assert.doesNotMatch(
    styles,
    /\.windy-view__transcript\.is-browsing\s+\.windy-view__messages\s*\{[^}]*padding/,
  );
});
