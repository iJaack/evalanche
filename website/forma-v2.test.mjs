import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// Run with node --test locally; npm test also discovers this file through Vitest.
const { test } = await import(process.env.VITEST ? 'vitest' : 'node:test');
const website = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, website), 'utf8');
const css = read('evalanche.css');
const assets = readdirSync(website, { recursive: true })
  .filter((name) => /\.(?:css|html|svg)$/.test(name));
const palette = Object.values(JSON.parse(read('forma-v2/palettes.json')))[0].dark;
const normalise = (value) => value.replace(/\s/g, '').replace(/\b0\./g, '.');

// Construct forbidden literals so the acceptance grep stays empty across website/.
const pureBlack = new RegExp('#0{3}\\b|#0{6}|:\\s*black\\b', 'i');
const slate = new RegExp('#(?:' + [
  '94a3b8', '64748b', 'cbd5e1', 'e2e8f0', 'f1f5f9', '0a0c10',
  '475569', 'f8fafc',
].join('|') + ')', 'i');

test('website CSS, HTML and SVG use no pure black or legacy slate colours', () => {
  for (const asset of assets) {
    const source = read(asset);
    assert.doesNotMatch(source, pureBlack, asset);
    assert.doesNotMatch(source, slate, asset);
  }
});

test('CSS palette tokens match the local Evalanche dark fixture', () => {
  for (const [token, key] of Object.entries({
    bg: 'bg', surface: 'surface', ink: 'ink', 'ink-2': 'ink2',
    t2: 't2', t3: 't3', accent: 'accent', 'accent-text': 'accentText',
    'on-accent': 'onAccent',
  })) {
    const value = css.match(new RegExp(`--jk-${token}:\\s*([^;]+);`))?.[1];
    assert.ok(value, `missing --jk-${token}`);
    assert.equal(normalise(value), normalise(palette[key]), token);
  }
  assert.match(css, /--jk-hair:\s*rgba\(237,232,224,\.12\)/);
  assert.match(read('index.html'), /name="theme-color" content="#12100e"/);
});

test('local contrast.py passes all Evalanche dark text and mark pairs', () => {
  const result = spawnSync('python3', ['forma-v2/contrast.py'], {
    cwd: website,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /FAIL: 0\b/);
});

test('code window has no window-control dots', () => {
  assert.doesNotMatch(read('index.html'), /ev-dot/);
  assert.doesNotMatch(css, /\.ev-dot\b/);
});

test('flat effects, warm shadow and accessible primary states remain', () => {
  for (const asset of assets) {
    assert.doesNotMatch(read(asset), /gradient\(|<(?:linear|radial)Gradient/i, asset);
  }
  assert.ok((css.match(/(?<![-\w])backdrop-filter:/g) ?? []).length <= 1);
  assert.doesNotMatch(css, /box-shadow:\s*0\s+0\s/);
  assert.doesNotMatch(css, /rgba\(0,\s*0,\s*0,/);
  assert.match(css, /box-shadow:[^;]*rgba\(8,6,4,/);
  assert.match(css, /\.ev-btn-primary\s*\{[^}]*color:\s*var\(--jk-on-accent\)/);
  assert.match(css, /\.ev-btn-primary:hover\s*\{\s*background:\s*#ec6a7a;\s*color:\s*var\(--jk-on-accent\)/);
  assert.match(css, /color:\s*#9ecca3/);
});

test('reduced motion disables transitions and animations throughout the site', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation:\s*none\s*!important;[^}]*transition:\s*none\s*!important;/);
  assert.doesNotMatch(css, /animation[^;{}]*\binfinite\b/);
});
