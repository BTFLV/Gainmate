import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Music2,
  Minus,
  Trash2,
} from 'lucide-react';
import { db, duration, filename, prediction, signed } from './audio';
import { Waveform } from './Visuals';
import type { Settings, Track } from './types';
export type SortKey =
  | 'title'
  | 'artist'
  | 'filename'
  | 'duration'
  | 'lufs'
  | 'peak'
  | 'gain'
  | 'output'
  | 'status';
interface Props {
  tracks: Track[];
  selected: Set<string>;
  active: string | null;
  settings: Settings;
  toggle: (path: string) => void;
  toggleAll: () => void;
  onActive: (path: string) => void;
  remove: (path: string) => void;
  sort: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
  busy: boolean;
}
export default function TrackTable(p: Props) {
  const scroll = useRef<HTMLDivElement>(null);
  // React Compiler is not enabled; TanStack owns virtualization state.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtual = useVirtualizer({
    count: p.tracks.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 58,
    overscan: 8,
  });
  const headers: [string, SortKey][] = [
    ['Track / artist', 'title'],
    ['Length', 'duration'],
    ['LUFS', 'lufs'],
    ['True peak', 'peak'],
    ['Gain', 'gain'],
    ['Est. LUFS', 'output'],
    ['Status', 'status'],
  ];
  return (
    <div className="track-table">
      <div className="track-grid table-head">
        <input
          type="checkbox"
          aria-label="Select all visible tracks"
          checked={
            p.tracks.length > 0 && p.tracks.every((t) => p.selected.has(t.path))
          }
          onChange={p.toggleAll}
        />
        {headers.map(([label, key], i) =>
          i === 0 ? (
            <div className="track-heading" key={label}>
              <select
                aria-label="Sort track names by"
                value={
                  ['title', 'artist', 'filename'].includes(p.sort)
                    ? p.sort
                    : 'title'
                }
                onChange={(e) => p.onSort(e.target.value as SortKey)}
              >
                <option value="title">Track / artist</option>
                <option value="artist">Artist / track</option>
                <option value="filename">Filename</option>
              </select>
              <button
                aria-label="Reverse track name order"
                onClick={() =>
                  p.onSort(
                    ['title', 'artist', 'filename'].includes(p.sort)
                      ? p.sort
                      : 'title',
                  )
                }
              >
                {p.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
              </button>
            </div>
          ) : (
            <button
              key={label}
              className={i === 0 ? 'track-heading' : ''}
              onClick={() => p.onSort(key)}
            >
              {label}
              {p.sort === key &&
                (p.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
            </button>
          ),
        )}
        <span />
      </div>
      <div
        className="table-scroll"
        ref={scroll}
        role="table"
        aria-label="Audio collection"
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((v) => {
            const t = p.tracks[v.index],
              a = t.analysis,
              guess = a ? prediction(a, p.settings) : null;
            return (
              <div
                key={t.path}
                className={`track-grid track-row ${p.active === t.path ? 'active' : ''}`}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: v.size,
                  transform: `translateY(${v.start}px)`,
                }}
                role="row"
                aria-selected={p.active === t.path}
                onClick={() => p.onActive(t.path)}
              >
                <input
                  type="checkbox"
                  checked={p.selected.has(t.path)}
                  aria-label={`Select ${a?.info.title || filename(t.path)}`}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => p.toggle(t.path)}
                />
                <div className="track-name">
                  <div className={`track-cover cover-${v.index % 4}`}>
                    <Music2 size={18} />
                    <small>
                      {a?.info.format ?? filename(t.path).split('.').pop()}
                    </small>
                  </div>
                  <button onClick={() => p.onActive(t.path)} title={t.path}>
                    <strong>{a?.info.title || filename(t.path)}</strong>
                    <span>
                      {a?.info.artist || 'Unknown artist'}
                      {a?.info.album && ` · ${a.info.album}`}
                    </span>
                  </button>
                  {a && <Waveform data={a.waveform} />}
                </div>
                <span className="muted mono">
                  {a ? duration(a.info.duration) : '—'}
                </span>
                <span className="mono lufs">{a ? db(a.integrated) : '—'}</span>
                <span
                  className={`mono ${(a?.truePeak ?? -1) > 0 ? 'amber' : 'muted'}`}
                >
                  {a ? db(a.truePeak) : '—'}
                </span>
                <span
                  className={`mono ${guess && guess.gain > 0 ? 'accent' : 'muted'}`}
                >
                  {guess ? signed(guess.gain) : '—'}
                </span>
                <span className="mono muted">
                  {guess ? db(guess.output) : '—'}
                </span>
                <span
                  className={`status ${t.state === 'error' ? 'error' : t.state === 'done' ? 'verified' : guess?.blocked ? 'error' : guess && guess.limiting > 0.05 ? 'limited' : ''}`}
                  title={t.error || t.operation?.message || ''}
                >
                  {t.state === 'error' ? (
                    <>
                      <CircleAlert size={12} />
                      Error
                    </>
                  ) : t.state === 'done' ? (
                    <>
                      <Check size={12} />
                      Verified
                    </>
                  ) : !a ? (
                    'Queued'
                  ) : a.integrated == null ? (
                    'Silence'
                  ) : guess?.blocked ? (
                    'Lower target'
                  ) : guess && guess.limiting > 0.05 ? (
                    'Limiting'
                  ) : (
                    <>
                      <Minus size={11} />
                      {guess && Math.abs(guess.output - p.settings.target) > 0.3
                        ? 'Peak limited'
                        : 'Gain only'}
                    </>
                  )}
                </span>
                <button
                  className="icon-button remove-track"
                  disabled={p.busy}
                  aria-label={`Remove ${a?.info.title || filename(t.path)}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.remove(t.path);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
        {!p.tracks.length && (
          <div className="no-results">No tracks match your search.</div>
        )}
      </div>
    </div>
  );
}
