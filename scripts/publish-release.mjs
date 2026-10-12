import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
export async function publish({
  github,
  context,
  core,
  artifactDirectory = 'release-artifacts',
}) {
  const repo = context.repo,
    sha = context.sha;
  const main = await github.rest.git.getRef({ ...repo, ref: 'heads/main' });
  if (main.data.object.sha !== sha) {
    core.notice(
      'A newer main commit exists; this older build will not replace latest.',
    );
    return;
  }
  const folder = artifactDirectory,
    files = readdirSync(folder);
  for (const ending of [
    'macos-arm64.dmg',
    'macos-x64.dmg',
    'windows-x64.exe',
    'macos-arm64_sources-and-notices.tar.gz',
    'macos-x64_sources-and-notices.tar.gz',
    'windows-x64_sources-and-notices.tar.gz',
  ])
    if (files.filter((f) => f.endsWith(ending)).length !== 1)
      throw new Error(`Missing or duplicate release artifact: ${ending}`);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const stageTag = `gainmate-build-${context.runId}-${context.runAttempt}`;
  const body = `GainMate ${version} · commit ${sha}\n\nLocal, verified loudness normalization for MP3, WAV and FLAC.\n\nChoose macos-arm64.dmg for Apple Silicon, macos-x64.dmg for Intel, or windows-x64.exe for the Windows installer. The sources-and-notices archives accompany the bundled LGPL audio tools. SHA-256 checksum files are included.\n\nmacOS builds are ad-hoc signed unless Apple signing secrets are configured. They may require approval in System Settings → Privacy & Security. Windows installers are unsigned unless a future signing service is configured.\n\nThe latest tag is mutable; the application version is ${version}. All artifacts in this release come from the single commit above. See the README for usage, audio limitations and licensing.`;
  const staged = (
    await github.rest.repos.createRelease({
      ...repo,
      tag_name: stageTag,
      target_commitish: sha,
      name: 'GainMate build staging',
      body,
      draft: true,
      prerelease: false,
    })
  ).data;
  let previous = null,
    oldSha = null,
    archived = false,
    promoted = false;
  try {
    for (const file of files) {
      const path = join(folder, file);
      await github.rest.repos.uploadReleaseAsset({
        ...repo,
        release_id: staged.id,
        name: file,
        data: readFileSync(path),
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': statSync(path).size,
        },
      });
    }
    // Do not touch the currently published release until every upload succeeds.
    try {
      previous = (
        await github.rest.repos.getReleaseByTag({ ...repo, tag: 'latest' })
      ).data;
      oldSha = (await github.rest.git.getRef({ ...repo, ref: 'tags/latest' }))
        .data.object.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    if (previous) {
      const archiveTag = `gainmate-previous-${previous.id}`;
      await github.rest.git
        .createRef({ ...repo, ref: `refs/tags/${archiveTag}`, sha: oldSha })
        .catch((e) => {
          if (e.status !== 422) throw e;
        });
      await github.rest.repos.updateRelease({
        ...repo,
        release_id: previous.id,
        tag_name: archiveTag,
        draft: true,
      });
      archived = true;
    }
    try {
      await github.rest.git.updateRef({
        ...repo,
        ref: 'tags/latest',
        sha,
        force: true,
      });
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e;
      await github.rest.git.createRef({
        ...repo,
        ref: 'refs/tags/latest',
        sha,
      });
    }
    await github.rest.repos.updateRelease({
      ...repo,
      release_id: staged.id,
      tag_name: 'latest',
      name: 'Latest GainMate Release',
      body,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    });
    promoted = true;
    if (previous) {
      await github.rest.repos.deleteRelease({
        ...repo,
        release_id: previous.id,
      });
      await github.rest.git.deleteRef({
        ...repo,
        ref: `tags/gainmate-previous-${previous.id}`,
      });
    }
    await github.rest.git
      .deleteRef({ ...repo, ref: `tags/${stageTag}` })
      .catch(() => {});
    core.notice(`Published all installers from ${sha}`);
  } catch (e) {
    if (!promoted && archived && previous) {
      await github.rest.git.updateRef({
        ...repo,
        ref: 'tags/latest',
        sha: oldSha,
        force: true,
      });
      await github.rest.repos.updateRelease({
        ...repo,
        release_id: previous.id,
        tag_name: 'latest',
        draft: false,
        prerelease: false,
        make_latest: 'true',
      });
    }
    throw e;
  }
}
