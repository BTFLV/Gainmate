import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from '../scripts/publish-release.mjs';
let dirs = [];
function setup({
  uploadFails = false,
  promoteFails = false,
  head = 'new',
  changedFiles = [{ filename: 'src/App.tsx' }],
  comparisonStatus = 'ahead',
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'gainmate-release-'));
  dirs.push(folder);
  for (const ending of [
    'macos-arm64.dmg',
    'macos-x64.dmg',
    'windows-x64.exe',
    'macos-arm64_sources-and-notices.tar.gz',
    'macos-x64_sources-and-notices.tar.gz',
    'windows-x64_sources-and-notices.tar.gz',
  ])
    writeFileSync(join(folder, `GainMate_0.1.0_${ending}`), 'test');
  const order = [];
  const github = {
    rest: {
      git: {
        getRef: vi.fn(async ({ ref }) => ({
          data: { object: { sha: ref === 'heads/main' ? head : 'old' } },
        })),
        createRef: vi.fn(async () => {}),
        updateRef: vi.fn(async (args) => {
          order.push(['tag', args.sha]);
        }),
        deleteRef: vi.fn(async () => {}),
      },
      repos: {
        compareCommitsWithBasehead: vi.fn(async () => ({
          data: { status: comparisonStatus, files: changedFiles },
        })),
        createRelease: vi.fn(async () => ({ data: { id: 20 } })),
        uploadReleaseAsset: vi.fn(async () => {
          order.push(['upload']);
          if (uploadFails) throw new Error('upload failed');
        }),
        getReleaseByTag: vi.fn(async () => ({ data: { id: 10 } })),
        updateRelease: vi.fn(async (args) => {
          order.push(['release', args.release_id, args.draft]);
          if (promoteFails && args.release_id === 20)
            throw new Error('promotion failed');
        }),
        deleteRelease: vi.fn(async (args) =>
          order.push(['delete', args.release_id]),
        ),
      },
    },
  };
  return {
    github,
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      sha: 'new',
      runId: 1,
      runAttempt: 1,
    },
    core: { notice: vi.fn() },
    artifactDirectory: folder,
    order,
  };
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
describe('rolling release promotion', () => {
  it('uploads a full set before changing latest, then publishes a normal release', async () => {
    const s = setup();
    await publish(s);
    expect(s.order.slice(0, 6)).toEqual(Array(6).fill(['upload']));
    expect(s.github.rest.repos.updateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        release_id: 20,
        name: 'Latest GainMate Release',
        tag_name: 'latest',
        draft: false,
        prerelease: false,
        make_latest: 'true',
      }),
    );
    expect(s.order.findIndex((x) => x[0] === 'delete')).toBeGreaterThan(
      s.order.findIndex((x) => x[0] === 'release' && x[1] === 20),
    );
  });
  it('leaves latest untouched if an upload fails', async () => {
    const s = setup({ uploadFails: true });
    await expect(publish(s)).rejects.toThrow('upload failed');
    expect(s.github.rest.git.updateRef).not.toHaveBeenCalled();
    expect(s.github.rest.repos.updateRelease).not.toHaveBeenCalled();
  });
  it('restores the previous release and tag on promotion failure', async () => {
    const s = setup({ promoteFails: true });
    await expect(publish(s)).rejects.toThrow('promotion failed');
    expect(s.github.rest.git.updateRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ sha: 'old' }),
    );
    expect(s.github.rest.repos.updateRelease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        release_id: 10,
        tag_name: 'latest',
        draft: false,
      }),
    );
    expect(s.github.rest.repos.deleteRelease).not.toHaveBeenCalled();
  });
  it('does not publish an outdated main build', async () => {
    const s = setup({ head: 'newer' });
    await publish(s);
    expect(s.github.rest.repos.createRelease).not.toHaveBeenCalled();
  });
  it('publishes the built commit when only documentation changed afterwards', async () => {
    const s = setup({
      head: 'newer',
      changedFiles: [
        { filename: 'README.md' },
        { filename: 'docs/screenshots/collection.png' },
      ],
    });
    await publish(s);
    expect(s.github.rest.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ target_commitish: 'new' }),
    );
    expect(s.github.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'tags/latest', sha: 'new' }),
    );
  });
  it('rejects code renamed into the documentation directory', async () => {
    const s = setup({
      head: 'newer',
      changedFiles: [
        { filename: 'docs/old-code.txt', previous_filename: 'src/App.tsx' },
      ],
    });
    await publish(s);
    expect(s.github.rest.repos.createRelease).not.toHaveBeenCalled();
  });
  it('rejects divergent history even when the returned files are documentation', async () => {
    const s = setup({
      head: 'newer',
      comparisonStatus: 'diverged',
      changedFiles: [{ filename: 'README.md' }],
    });
    await publish(s);
    expect(s.github.rest.repos.createRelease).not.toHaveBeenCalled();
  });
  it('rejects a potentially truncated file comparison', async () => {
    const s = setup({
      head: 'newer',
      changedFiles: Array.from({ length: 300 }, (_, i) => ({
        filename: `docs/${i}.md`,
      })),
    });
    await publish(s);
    expect(s.github.rest.repos.createRelease).not.toHaveBeenCalled();
  });
});
