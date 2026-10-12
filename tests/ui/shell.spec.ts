import { test, expect } from '@playwright/test';
test('welcome, configuration and guide work without a desktop bridge', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Audio Library' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review export' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '-14', exact: true }).click();
  await expect(
    page.getByRole('slider', { name: 'Target loudness' }),
  ).toHaveValue('-14');
  await page
    .getByRole('button', { name: /Safe Gain Keep all dynamics/ })
    .click();
  await page.reload();
  await expect(
    page.getByRole('button', { name: /Safe Gain Keep all dynamics/ }),
  ).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Add audio files' }).click();
  await expect(page.getByRole('alert')).toContainText('desktop app');
  await page.getByRole('button', { name: 'Dismiss message' }).click();
  await page.getByRole('button', { name: 'Documentation' }).click();
  await expect(
    page.getByRole('heading', { name: 'MP3 encoding' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No operations recorded' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test('controls stay reachable at the minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 680 });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Add audio files' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Review export' }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1000,
  );
  await page.getByRole('button', { name: 'Documentation' }).click();
  await expect(
    page.getByRole('heading', { name: 'Processing reference' }),
  ).toBeVisible();
});
