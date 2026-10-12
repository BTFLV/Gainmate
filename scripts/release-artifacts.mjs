import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const target = process.env.GAINMATE_TARGET,
  label = process.env.GAINMATE_LABEL;
if (!target || !label)
  throw new Error('Set GAINMATE_TARGET and GAINMATE_LABEL');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const output = 'release-artifacts';
mkdirSync(output, { recursive: true });
const bundle =
  process.env.GAINMATE_BUNDLE_DIR ||
  join(
    'target',
    target,
    'release',
    'bundle',
    label.startsWith('windows') ? 'nsis' : 'dmg',
  );
const installers = readdirSync(bundle).filter((f) =>
  f.endsWith(label.startsWith('windows') ? '.exe' : '.dmg'),
);
if (installers.length !== 1)
  throw new Error(`Expected exactly one installer in ${bundle}`);
const ext = label.startsWith('windows') ? 'exe' : 'dmg';
cpSync(
  join(bundle, installers[0]),
  join(output, `GainMate_${version}_${label}.${ext}`),
);
const sourceDir = join('.audio-build', `release-source-${label}`);
mkdirSync(sourceDir, { recursive: true });
mkdirSync(join(sourceDir, '.audio-build', 'downloads'), { recursive: true });
for (const file of ['ffmpeg-7.1.2.tar.xz', 'lame-3.100.tar.gz'])
  cpSync(
    join('.audio-build', 'downloads', file),
    join(sourceDir, '.audio-build', 'downloads', file),
  );
for (const file of [
  'scripts/build-audio.sh',
  'THIRD_PARTY.md',
  'LICENSE',
  'assets/ZLIB-LICENSE.txt',
]) {
  const dest = join(sourceDir, file);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(file, dest);
}
writeFileSync(
  join(sourceDir, 'BUILDING.txt'),
  `Install a C compiler, make, pkg-config, curl, tar, xz, Perl (shasum), Rust and zlib development headers. On Windows use MINGW64 MSYS2 and set GAINMATE_TARGET=x86_64-pc-windows-msvc. Run bash scripts/build-audio.sh. Source archives are already in .audio-build/downloads; no source download is needed. The produced ffmpeg/ffprobe executables are independent of GainMate and can replace the bundled tools.\n`,
);
cpSync(
  'src-tauri/resources/audio',
  join(sourceDir, 'licenses-and-configuration'),
  { recursive: true },
);
const metadata = spawnSync(
  'cargo',
  ['metadata', '--locked', '--format-version', '1'],
  { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);
if (metadata.status !== 0) throw new Error(metadata.stderr);
const rust = JSON.parse(metadata.stdout).packages.map((p) => ({
  name: p.name,
  version: p.version,
  license: p.license,
  source: p.source,
}));
const npm = Object.entries(
  JSON.parse(readFileSync('package-lock.json', 'utf8')).packages,
).map(([path, p]) => ({ name: path, version: p.version, license: p.license }));
writeFileSync(
  join(sourceDir, 'dependency-licenses.json'),
  JSON.stringify({ rust, npm }, null, 2),
);
// Include each Rust dependency's actual notice/license files, not only SPDX identifiers.
for (const p of JSON.parse(metadata.stdout).packages) {
  const dir = p.manifest_path.replace(/Cargo.toml$/, '');
  const dest = join(
    sourceDir,
    'dependency-notices',
    'rust',
    `${p.name}-${p.version}`,
  );
  if (p.license?.includes('MPL-2.0')) {
    cpSync(
      dir,
      join(sourceDir, 'mpl-corresponding-source', `${p.name}-${p.version}`),
      { recursive: true },
    );
  }
  for (const file of readdirSync(dir).filter((f) =>
    /^(license|copying|notice)/i.test(f),
  )) {
    mkdirSync(dest, { recursive: true });
    cpSync(join(dir, file), join(dest, file), { recursive: true });
  }
}
for (const path of Object.keys(
  JSON.parse(readFileSync('package-lock.json', 'utf8')).packages,
)) {
  if (!path || !existsSync(path)) continue;
  for (const file of readdirSync(path).filter((f) =>
    /^(license|copying|notice)/i.test(f),
  )) {
    const dest = join(sourceDir, 'dependency-notices', 'npm', path);
    mkdirSync(dest, { recursive: true });
    cpSync(join(path, file), join(dest, file), { recursive: true });
  }
}
const archive = join(
  output,
  `GainMate_${version}_${label}_sources-and-notices.tar.gz`,
);
const tar = spawnSync('tar', ['-czf', archive, '-C', sourceDir, '.'], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (tar.status !== 0) throw new Error('Source packaging failed');
const sums = readdirSync(output)
  .filter((f) => f.includes(label) && !f.endsWith('.sha256'))
  .map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(output, f)))
        .digest('hex')}  ${f}`,
  )
  .join('\n');
writeFileSync(join(output, `${label}.sha256`), sums + '\n');
