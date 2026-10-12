import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
process.env.PATH = `${join(homedir(), '.cargo', 'bin')}${delimiter}${process.env.PATH}`;
const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout?.match(
  /host: (.*)/,
)?.[1];
if (!host)
  throw new Error('Install Rust with rustup before starting GainMate.');
const extension = process.platform === 'win32' ? '.exe' : '';
for (const tool of ['ffmpeg', 'ffprobe'])
  if (!existsSync(`src-tauri/binaries/${tool}-${host}${extension}`))
    throw new Error(
      'Bundled audio tools are missing. Run npm run audio:build first (MSYS2 on Windows).',
    );
const cli = join('node_modules', '@tauri-apps', 'cli', 'tauri.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
