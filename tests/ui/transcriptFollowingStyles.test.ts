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
    /background-color:\s*var\(--windy-latest-background\)/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /background-image:\s*none/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /border:\s*1px solid var\(--windy-accent\)/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /color:\s*var\(--windy-latest-foreground\)/,
  );
  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /opacity:\s*1/,
  );
  assert.match(
    hoverRule?.groups?.declarations ?? '',
    /background-color:\s*var\(--windy-latest-background-hover\)/,
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
  assert.match(
    styles,
    /--windy-latest-background:\s*#[0-9a-f]{6}/i,
  );
  assert.match(
    styles,
    /\.theme-dark\s+\.windy-view\s*\{[^}]*--windy-latest-background:\s*#[0-9a-f]{6}/i,
  );
});
