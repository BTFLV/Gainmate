import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Folder,
  FolderOpen,
  ShieldCheck,
  X,
} from 'lucide-react';
import { db, filename } from './audio';
import type { Plan, Rekordbox, Settings } from './types';
export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('keydown', handle);
      previous?.focus();
    };
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close dialog"
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function ExportDialog({
  paths,
  settings,
  setSettings,
  close,
  start,
  onError,
}: {
  paths: string[];
  settings: Settings;
  setSettings: (s: Settings) => void;
  close: () => void;
  start: () => void;
  onError: (s: string) => void;
}) {
  const [result, setResult] = useState<{
      key: string;
      plan: Plan | null;
      error: string;
    } | null>(null),
    [ack, setAck] = useState(false);
  const key = JSON.stringify({ paths, settings });
  const plan = result?.key === key ? result.plan : null;
  const error = result?.key === key ? result.error : '';
  const loading = result?.key !== key;
  useEffect(() => {
    let active = true;
    const args = JSON.parse(key);
    invoke<Plan>('export_plan', args)
      .then((plan) => {
        if (active) setResult({ key, plan, error: '' });
      })
      .catch((e) => {
        if (active) setResult({ key, plan: null, error: String(e) });
      });
    return () => {
      active = false;
    };
  }, [key]);
  const update = (patch: Partial<Settings>) => {
    setAck(false);
    setSettings({ ...settings, ...patch });
  };
  const choose = async (backup = false) => {
    try {
      const p = await open({
        directory: true,
        title: backup ? 'Choose backup folder' : 'Choose export folder',
      });
      if (typeof p === 'string')
        update(backup ? { backupDirectory: p } : { destination: p });
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <Modal title="Export configuration" close={close}>
      <p className="modal-intro">
        Review the destination and verified processing plan for {paths.length}{' '}
        selected tracks.
      </p>
      <div className="export-mode">
        <button
          className={!settings.replace ? 'active' : ''}
          onClick={() => update({ replace: false })}
        >
          <FolderOpen size={19} />
          <span>
            Export to a folder<small>Keep your original collection</small>
          </span>
          {!settings.replace && <Check size={16} />}
        </button>
        <button
          className={settings.replace ? 'active' : ''}
          onClick={() => update({ replace: true })}
        >
          <ShieldCheck size={19} />
          <span>
            Replace originals<small>Keep existing library paths</small>
          </span>
          {settings.replace && <Check size={16} />}
        </button>
      </div>
      {!settings.replace ? (
        <>
          <label className="field-label">DESTINATION</label>
          <button className="path-picker" onClick={() => choose()}>
            <Folder size={17} />
            <span>{settings.destination || 'Choose an export folder'}</span>
            <ChevronRight size={16} />
          </button>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={settings.preserveFolders}
              onChange={(e) => update({ preserveFolders: e.target.checked })}
            />
            Preserve folders below the common source folder
          </label>
        </>
      ) : (
        <>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={settings.backup}
              onChange={(e) => update({ backup: e.target.checked })}
            />
            Create verified backups of the original bytes
          </label>
          {settings.backup && (
            <button className="path-picker" onClick={() => choose(true)}>
              <Folder size={17} />
              <span>
                {settings.backupDirectory ||
                  'Beside originals, in .gainmate-backups'}
              </span>
              <ChevronRight size={16} />
            </button>
          )}
          <p className="warning-box">
            Existing audio files will be replaced. Rekordbox may need a fresh
            track analysis.{' '}
            {settings.backup
              ? 'You can restore unchanged files from History.'
              : 'Backups are off. This operation cannot be undone in GainMate.'}
          </p>
        </>
      )}
      <div className="export-recap">
        <span>
          {settings.mode === 'precise' ? 'Precise Normalize' : 'Safe Gain'}
        </span>
        <strong>{db(settings.target)} LUFS</strong>
        <span>Ceiling</span>
        <strong>{db(settings.ceiling)} dBTP</strong>
      </div>
      {plan && (
        <>
          <div className="plan-counts">
            {[
              ['Created', plan.creates],
              ['Replaced', plan.overwrites],
              ['Backed up', plan.backups],
              ['Skipped', plan.skips],
            ].map(([label, n]) => (
              <div key={label}>
                <strong>{n}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="plan-files">
            {plan.items.map((i) => (
              <div key={i.source} className={i.skip ? 'amber' : ''}>
                <span title={i.source}>{filename(i.source)}</span>
                <small title={i.output}>{i.skip || `→ ${i.output}`}</small>
              </div>
            ))}
          </div>
          <label className="checkbox-line acknowledge">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            {settings.replace
              ? 'I understand the originals will be replaced.'
              : 'I have reviewed the output paths and processing mode.'}
          </label>
        </>
      )}
      {error && <p className="warning-box">{error}</p>}
      <p className="footnote">
        MP3 uses LAME V0 re-encoding. Limiting can change transients. Each
        completed output must pass timing, loudness and true peak checks.
      </p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={close}>
          Back to review
        </button>
        <button
          className="primary-button"
          disabled={
            loading || !plan || !ack || !(plan.creates + plan.overwrites)
          }
          onClick={start}
        >
          {loading
            ? 'Checking…'
            : `Normalize ${plan ? plan.creates + plan.overwrites : 0} tracks`}
          <ArrowRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
export function RekordboxDialog({
  library,
  close,
  importTracks,
}: {
  library: Rekordbox;
  close: () => void;
  importTracks: (paths: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [playlist, setPlaylist] = useState(-1),
    [query, setQuery] = useState('');
  const list = library.tracks.filter(
    (t) =>
      (playlist < 0 || library.playlists[playlist].trackIds.includes(t.id)) &&
      `${t.title} ${t.artist}`.toLowerCase().includes(query.toLowerCase()),
  );
  const addPlaylist = (index: number) => {
    const ids =
      index < 0
        ? library.tracks.map((t) => t.id)
        : library.playlists[index].trackIds;
    setSelected(
      (current) =>
        new Set([
          ...current,
          ...library.tracks
            .filter((t) => ids.includes(t.id) && !t.missing && t.path)
            .map((t) => t.id),
        ]),
    );
  };
  return (
    <Modal title="Import Rekordbox XML" close={close} wide>
      <p className="modal-intro">
        Choose playlists or individual tracks. Your Rekordbox database stays
        untouched.
      </p>
      <div className="rekordbox-layout">
        <div className="playlist-list">
          <button
            className={playlist < 0 ? 'active' : ''}
            onClick={() => setPlaylist(-1)}
          >
            All tracks <small>{library.tracks.length}</small>
          </button>
          {library.playlists.map((p, i) => (
            <button
              key={i}
              className={playlist === i ? 'active' : ''}
              onClick={() => setPlaylist(i)}
            >
              {p.name}
              <small>{p.trackIds.length}</small>
            </button>
          ))}
        </div>
        <div className="rekordbox-tracks">
          <div className="rekordbox-toolbar">
            <input
              className="search-input"
              placeholder="Find a track…"
              aria-label="Search Rekordbox tracks"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              className="text-button"
              onClick={() => addPlaylist(playlist)}
            >
              Select playlist
            </button>
          </div>
          <div className="rekordbox-scroll">
            {list.map((t) => (
              <label key={t.id} className="rekordbox-track">
                <input
                  type="checkbox"
                  disabled={t.missing || !t.path}
                  checked={selected.has(t.id)}
                  onChange={() =>
                    setSelected((old) => {
                      const s = new Set(old);
                      if (s.has(t.id)) s.delete(t.id);
                      else s.add(t.id);
                      return s;
                    })
                  }
                />
                <span>
                  {t.title}
                  <small>{t.artist}</small>
                </span>
                {t.missing && <small className="amber">Missing file</small>}
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="modal-actions">
        <span className="muted">
          {selected.size} selected ·{' '}
          {library.tracks.filter((t) => t.missing).length} unavailable
        </span>
        <button
          className="primary-button"
          disabled={!selected.size}
          onClick={() =>
            importTracks(
              library.tracks
                .filter((t) => selected.has(t.id) && t.path)
                .map((t) => t.path!),
            )
          }
        >
          Import selected
          <ArrowRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
