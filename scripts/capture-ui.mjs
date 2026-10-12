/* global window, document */
// Screenshots of the actual UI, backed by real Rust analysis and processing.
// Only the native window/dialog transport is adapted for a browser in this developer script.
import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'gainmate-ui-'));
const fixtures = resolve('fixtures-generated');
const paths = readdirSync(fixtures)
  .filter((p) => /\.(wav|mp3|flac)$/i.test(p))
  .map((p) => join(fixtures, p));
if (!paths.length) throw new Error('Run scripts/generate-fixtures.py first');
const env = {
  ...process.env,
  GAINMATE_FFMPEG: resolve('src-tauri/binaries/ffmpeg-aarch64-apple-darwin'),
  GAINMATE_FFPROBE: resolve('src-tauri/binaries/ffprobe-aarch64-apple-darwin'),
};
function command(name, args = {}) {
  return new Promise((accept, reject) => {
    const process = spawn(resolve('target/release/examples/command'), [], {
      env,
    });
    let stdout = '',
      stderr = '';
    process.stdout.on('data', (s) => (stdout += s));
    process.stderr.on('data', (s) => (stderr += s));
    process.on('error', reject);
    process.on('close', () => {
      try {
        const result = JSON.parse(stdout);
        if (result.error) reject(new Error(result.error));
        else accept(result.ok);
      } catch (e) {
        reject(new Error(`${e}: ${stderr}`));
      }
    });
    process.stdin.end(JSON.stringify({ command: name, root, ...args }));
  });
}
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 920 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error(m.text());
});
await page.exposeFunction('gainmateTestCommand', async (name, args) => {
  if (name === 'plugin:dialog|open')
    return args.options.directory
      ? args.options.title.includes('export')
        ? join(root, 'output')
        : fixtures
      : paths;
  if (name === 'plugin:dialog|confirm') return true;
  return command(name, args);
});
await page.route('**/__test_audio?**', async (route) => {
  const path = new URL(route.request().url()).searchParams.get('path');
  if (
    !path ||
    (!path.startsWith(fixtures + '/') && !path.startsWith(root + '/'))
  )
    throw new Error('Unexpected preview path');
  await route.fulfill({
    body: readFileSync(path),
    contentType: path.endsWith('.mp3')
      ? 'audio/mpeg'
      : path.endsWith('.flac')
        ? 'audio/flac'
        : 'audio/wav',
  });
});
await page.addInitScript(() => {
  let seq = 0;
  const callbacks = new Map(),
    listeners = new Map();
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback: (cb) => {
      const id = ++seq;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    convertFileSrc: (path) =>
      `http://127.0.0.1:1420/__test_audio?path=${encodeURIComponent(path)}`,
    invoke: async (name, args = {}) => {
      if (name === 'plugin:event|listen') {
        listeners.set(args.handler, args.event);
        return args.handler;
      }
      if (name === 'plugin:event|unlisten') {
        listeners.delete(args.eventId);
        return;
      }
      const result = await window.gainmateTestCommand(name, args);
      if (name === 'analyze_files' || name === 'normalize_files') {
        const emit = (event, payload) => {
          for (const [id, ev] of listeners)
            if (ev === event) callbacks.get(id)?.({ event, id, payload });
        };
        for (const item of result) {
          if (item.error) console.error(item.path, item.error);
          emit('track', item);
        }
        emit('progress', {
          phase:
            name === 'analyze_files' ? 'Analyzing' : 'Processing & verifying',
          completed: result.length,
          total: result.length,
          path: null,
        });
        return;
      }
      return result;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event, id) => listeners.delete(id),
  };
});
try {
  await page.goto('http://127.0.0.1:1420');
  await page.getByRole('heading', { name: 'No tracks loaded' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/import.png' });
  await page.getByRole('button', { name: 'Add audio files' }).click();
  await expect(page.getByText('12 tracks ready', { exact: true })).toBeVisible({
    timeout: 90000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: /Night Drive GainMate Test/ }).click();
  await page.getByText('44.1 kHz', { exact: false }).waitFor();
  await page.locator('.table-scroll').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'docs/screenshots/collection.png' });
  await page.getByRole('button', { name: 'Short-term LUFS' }).click();
  await page.screenshot({ path: 'docs/screenshots/loudness.png' });
  await page.getByRole('button', { name: 'Review export' }).click();
  await page.getByRole('button', { name: 'Choose an export folder' }).click();
  await expect(
    page.getByRole('button', { name: 'Normalize 12 tracks' }),
  ).toBeDisabled();
  await page
    .getByRole('checkbox', {
      name: 'I have reviewed the output paths and processing mode.',
    })
    .check();
  await page.screenshot({ path: 'docs/screenshots/export.png' });
  await page.getByRole('button', { name: 'Normalize 12 tracks' }).click();
  await expect(
    page.getByText('12 tracks finished', { exact: true }),
  ).toBeVisible({ timeout: 180000 });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-list article')).toHaveCount(12, {
    timeout: 5000,
  });
  const history = await command('history');
  if (history.some((o) => !o.targetReached || o.truePeak > -1))
    throw new Error('Output failed verification');
  await page.screenshot({ path: 'docs/screenshots/history.png' });
  await expect(page.getByRole('alert')).toHaveCount(0);
  if (errors.length) throw new Error(errors.join('\n'));
  mkdirSync('.audio-build', { recursive: true });
  writeFileSync(
    '.audio-build/ui-validation.json',
    JSON.stringify({ tracks: paths.length, history, errors }, null, 2),
  );
  console.log(
    `Actual UI + real Rust engine: ${paths.length} tracks imported, analyzed, normalized and verified. Screenshots saved. Test output: ${root}`,
  );
} finally {
  await browser.close();
}
