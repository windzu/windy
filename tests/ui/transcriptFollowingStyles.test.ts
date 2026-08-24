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

  assert.match(
    buttonRule?.groups?.declarations ?? '',
    /position:\s*absolute/,
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
