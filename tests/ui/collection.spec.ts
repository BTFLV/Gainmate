import { test, expect } from '@playwright/test';

// Synthetic measurements isolate renderer behavior; actual audio is tested in Rust
// and scripts/capture-ui.mjs. No synthetic data is shipped with the application.
test('5,000 tracks stay virtualized, sortable and searchable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.addInitScript(() => {
    const paths = Array.from(
      { length: 5000 },
      (_, i) => `/library/${String(i).padStart(4, '0')}.wav`,
    );
    const listeners = new Map<number, string>();
    const callbacks = new Map<
      number,
      (event: { event: string; id: number; payload: unknown }) => void
    >();
    let sequence = 0;
    const emit = (event: string, payload: unknown) => {
      for (const [id, name] of listeners) {
        if (name === event) callbacks.get(id)?.({ event, id, payload });
      }
    };
    Object.assign(window, {
      isTauri: true,
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (_: string, id: number) => listeners.delete(id),
      },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: 'main' },
          currentWebview: { label: 'main' },
        },
        transformCallback: (
          cb: (event: { event: string; id: number; payload: unknown }) => void,
        ) => {
          callbacks.set(++sequence, cb);
          return sequence;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (
          command: string,
          args: { handler: number; event: string; eventId: number },
        ) => {
          if (command === 'plugin:event|listen') {
            listeners.set(args.handler, args.event);
            return args.handler;
          }
          if (command === 'plugin:event|unlisten')
            return listeners.delete(args.eventId);
          if (command === 'load_session' || command === 'history') return [];
          if (command === 'plugin:dialog|open') return paths;
          if (command === 'import_paths') return { paths, warnings: [] };
          if (command === 'analyze_files') {
            paths.forEach((path, i) =>
              emit('track', {
                path,
                analysis: {
                  path,
                  fingerprint: { bytes: 1000, modifiedNs: '0' },
                  integrated: -24 + (i % 12),
                  truePeak: -10,
                  samplePeak: -10,
                  lra: 4,
                  threshold: -34,
                  frames: 44100 * 60,
                  waveform: [0.2, 0.8, 0.4],
                  timeline: [],
                  warnings: [],
                  info: {
                    title: `Track ${String(i).padStart(4, '0')}`,
                    artist: i === 4999 ? 'A Artist' : 'Z Artist',
                    album: '',
                    duration: 60,
                    format: 'wav',
                    codec: 'pcm_s16le',
                    sampleRate: 44100,
                    channels: 2,
                    channelLayout: 'stereo',
                    bitDepth: 16,
                    hasArtwork: false,
                    tags: {},
                  },
                },
                error: null,
                operation: null,
              }),
            );
            emit('progress', {
              phase: 'Analyzing',
              completed: paths.length,
              total: paths.length,
              path: null,
            });
          }
        },
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add audio files' }).click();
  await expect(page.getByText('5000 of 5000 selected')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Track 0000 Z Artist/ }),
  ).toBeVisible();
  expect(await page.locator('.track-row').count()).toBeLessThan(40);
  await page
    .getByRole('combobox', { name: 'Sort track names by' })
    .selectOption('artist');
  await expect(page.locator('.track-row').first()).toContainText('Track 4999');
  await page
    .getByRole('combobox', { name: 'Sort track names by' })
    .selectOption('filename');
  await expect(page.locator('.track-row').first()).toContainText('Track 0000');
  await page.locator('.table-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(
    page.getByRole('button', { name: /Track 4999 A Artist/ }),
  ).toBeVisible();
  expect(await page.locator('.track-row').count()).toBeLessThan(40);
  await page
    .getByRole('textbox', { name: 'Search collection' })
    .fill('Track 0421');
  await expect(page.locator('.track-row')).toHaveCount(1);
  await expect(page.locator('.track-row')).toContainText('Track 0421');
  await page.getByRole('button', { name: '-14', exact: true }).click();
  await expect(
    page.getByRole('slider', { name: 'Target loudness' }),
  ).toHaveValue('-14');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1000,
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
});
