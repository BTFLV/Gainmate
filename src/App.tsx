import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open, confirm } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  ArrowRight,
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleAlert,
  Clock3,
  Disc3,
  FileAudio,
  FolderOpen,
  History,
  Library,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { db, filename, median, prediction } from './audio';
import { Histogram, Logo } from './Visuals';
import TrackTable from './TrackTable';
import type { SortKey } from './TrackTable';
import DetailPanel from './DetailPanel';
import { ExportDialog, RekordboxDialog } from './Dialogs';
import { defaultSettings } from './types';
import type {
  Operation,
  Progress,
  Rekordbox,
  Settings,
  Track,
  TrackEvent,
} from './types';

function loadSettings(): Settings {
  try {
    const v = JSON.parse(localStorage.getItem('gainmate-settings') || '{}');
    return {
      ...defaultSettings,
      target:
        typeof v.target === 'number' && v.target >= -36 && v.target <= -6
          ? v.target
          : -12,
      ceiling:
        typeof v.ceiling === 'number' && v.ceiling >= -9 && v.ceiling <= 0
          ? v.ceiling
          : -1,
      mode: v.mode === 'safe' ? 'safe' : 'precise',
    };
  } catch {
    return defaultSettings;
  }
}
export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [active, setActive] = useState<string | null>(null),
    [settings, setSettings] = useState(loadSettings),
    [page, setPage] = useState<'collection' | 'history' | 'guide'>(
      'collection',
    ),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [sort, setSort] = useState<SortKey>('title'),
    [desc, setDesc] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<Progress | null>(null),
    [error, setError] = useState(''),
    [dragging, setDragging] = useState(false),
    [exporting, setExporting] = useState(false),
    [rekordbox, setRekordbox] = useState<Rekordbox | null>(null),
    [operations, setOperations] = useState<Operation[]>([]),
    [importMenu, setImportMenu] = useState(false),
    [recent, setRecent] = useState<string[]>([]),
    [cancelled, setCancelled] = useState(false);
  const busyRef = useRef(false);
  const pending = useRef<TrackEvent[]>([]);
  const initialized = useRef(false);
  const tracksRef = useRef(tracks);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);
  const showError = useCallback((message: string) => setError(message), []);
  const setWorking = (value: boolean) => {
    busyRef.current = value;
    setBusy(value);
  };
  const refreshHistory = useCallback(() => {
    if (isTauri())
      invoke<Operation[]>('history')
        .then(setOperations)
        .catch((e) => showError(String(e)));
  }, [showError]);
  useEffect(() => {
    localStorage.setItem('gainmate-settings', JSON.stringify(settings));
  }, [settings]);
  const runAnalysis = async (paths: string[]) => {
    if (!paths.length) return;
    setWorking(true);
    setCancelled(false);
    setProgress({
      phase: 'Analyzing',
      completed: 0,
      total: paths.length,
      path: null,
    });
    try {
      await invoke('analyze_files', { paths });
    } catch (e) {
      showError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const importLocations = async (paths: string[]) => {
    if (busyRef.current) return;
    setImportMenu(false);
    setError('');
    setWorking(true);
    try {
      const r = await invoke<{ paths: string[]; warnings: string[] }>(
        'import_paths',
        { paths },
      );
      const existing = new Set(tracksRef.current.map((t) => t.path));
      const added = r.paths.filter((p) => !existing.has(p));
      setTracks((old) => [
        ...old,
        ...added.map((path) => ({ path, state: 'queued' as const })),
      ]);
      setSelected((old) => new Set([...old, ...added]));
      setPage('collection');
      const all = [...tracksRef.current.map((t) => t.path), ...added];
      await invoke('save_session', { paths: all });
      setRecent(all);
      if (r.warnings.length) showError(r.warnings.slice(0, 8).join('\n'));
      await runAnalysis(added);
    } catch (e) {
      showError(String(e));
    } finally {
      setWorking(false);
    }
  };
  useEffect(() => {
    if (!isTauri()) return;
    const listeners = [
      listen<TrackEvent>('track', (e) => pending.current.push(e.payload)),
      listen<Progress>('progress', (e) =>
        setProgress((old) =>
          old && old.phase === e.payload.phase
            ? {
                ...e.payload,
                completed: Math.max(old.completed, e.payload.completed),
              }
            : e.payload,
        ),
      ),
      getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'over') setDragging(true);
        else {
          setDragging(false);
          if (e.payload.type === 'drop') void importLocations(e.payload.paths);
        }
      }),
    ];
    const timer = setInterval(() => {
      if (!pending.current.length) return;
      const events = new Map(pending.current.splice(0).map((e) => [e.path, e]));
      setTracks((current) =>
        current.map((t) => {
          const e = events.get(t.path);
          return e
            ? {
                ...t,
                analysis: e.analysis ?? t.analysis,
                operation: e.operation ?? t.operation,
                error: e.error ?? undefined,
                state: e.error ? 'error' : e.operation ? 'done' : 'ready',
              }
            : t;
        }),
      );
    }, 80);
    if (!initialized.current) {
      initialized.current = true;
      invoke<string[]>('load_session')
        .then(setRecent)
        .catch((e) => showError(String(e)));
      refreshHistory();
    }
    return () => {
      clearInterval(timer);
      void Promise.all(listeners).then((unsub) => unsub.forEach((f) => f()));
    };
    // Event callbacks read current state through refs; subscriptions stay stable for a whole window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = async (kind: 'files' | 'folder' | 'xml') => {
    setImportMenu(false);
    try {
      if (!isTauri()) {
        showError(
          'Open GainMate as a desktop app with npm run desktop to import and process local audio.',
        );
        return;
      }
      const result = await open({
        directory: kind === 'folder',
        multiple: kind === 'files',
        title:
          kind === 'xml'
            ? 'Import Rekordbox XML'
            : kind === 'folder'
              ? 'Import audio folder'
              : 'Import audio files',
        filters:
          kind === 'folder'
            ? undefined
            : [
                {
                  name: kind === 'xml' ? 'Rekordbox XML' : 'Audio',
                  extensions: kind === 'xml' ? ['xml'] : ['mp3', 'wav', 'flac'],
                },
              ],
      });
      if (!result) return;
      if (kind === 'xml') {
        setWorking(true);
        setRekordbox(
          await invoke<Rekordbox>('read_rekordbox', { path: result }),
        );
        setWorking(false);
      } else await importLocations(Array.isArray(result) ? result : [result]);
    } catch (e) {
      setWorking(false);
      showError(String(e));
    }
  };
  const chosen = useMemo(
    () =>
      tracks
        .filter(
          (t) =>
            selected.has(t.path) && t.analysis && t.analysis.integrated != null,
        )
        .map((t) => t.path),
    [tracks, selected],
  );
  const review = () => {
    if (chosen.length && !busyRef.current) setExporting(true);
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      const input =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
        e.preventDefault();
        if (!busyRef.current) void pick(e.shiftKey ? 'folder' : 'files');
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !input) {
        e.preventDefault();
        setSelected(new Set(tracksRef.current.map((t) => t.path)));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        review();
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  });
  const normalized = async () => {
    setExporting(false);
    setWorking(true);
    setCancelled(false);
    setProgress({
      phase: 'Processing & verifying',
      completed: 0,
      total: chosen.length,
      path: null,
    });
    try {
      await invoke('normalize_files', { paths: chosen, settings });
      refreshHistory();
    } catch (e) {
      showError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const remove = (path: string) => {
    setTracks((old) => old.filter((t) => t.path !== path));
    setSelected((old) => {
      const s = new Set(old);
      s.delete(path);
      return s;
    });
    if (active === path) setActive(null);
    void invoke('save_session', {
      paths: tracks.filter((t) => t.path !== path).map((t) => t.path),
    }).catch((e) => showError(String(e)));
  };
  const visible = useMemo(() => {
    const list = tracks.filter((t) => {
      const a = t.analysis,
        p = a ? prediction(a, settings) : null;
      return (
        `${a?.info.title ?? ''} ${a?.info.artist ?? ''} ${t.path}`
          .toLowerCase()
          .includes(query.toLowerCase()) &&
        (filter === 'all' ||
          (filter === 'limiting' && (p?.limiting ?? 0) > 0) ||
          (filter === 'errors' && t.state === 'error') ||
          (filter === 'verified' && t.state === 'done'))
      );
    });
    return list.sort((a, b) => {
      let cmp: number;
      const aa = a.analysis,
        ba = b.analysis;
      if (sort === 'title' || sort === 'artist')
        cmp = (aa?.info[sort] ?? filename(a.path)).localeCompare(
          ba?.info[sort] ?? filename(b.path),
        );
      else if (sort === 'filename')
        cmp = filename(a.path).localeCompare(filename(b.path));
      else if (sort === 'status') cmp = a.state.localeCompare(b.state);
      else {
        const value = (t: Track) =>
          sort === 'lufs'
            ? (t.analysis?.integrated ?? -100)
            : sort === 'peak'
              ? (t.analysis?.truePeak ?? -100)
              : sort === 'duration'
                ? (t.analysis?.info.duration ?? 0)
                : t.analysis
                  ? (prediction(t.analysis, settings)?.[
                      sort === 'output' ? 'output' : 'gain'
                    ] ?? 0)
                  : 0;
        cmp = value(a) - value(b);
      }
      return desc ? -cmp : cmp;
    });
  }, [tracks, query, filter, sort, desc, settings]);
  const values = useMemo(
    () =>
      tracks.flatMap((t) =>
        t.analysis?.integrated != null ? [t.analysis.integrated] : [],
      ),
    [tracks],
  );
  const limitingCount = tracks.filter(
    (t) =>
      t.analysis && (prediction(t.analysis, settings)?.limiting ?? 0) > 0.05,
  ).length;
  const selectedTrack = tracks.find((t) => t.path === active);
  const toggle = (path: string) =>
    setSelected((old) => {
      const s = new Set(old);
      if (s.has(path)) s.delete(path);
      else s.add(path);
      return s;
    });
  const toggleAll = () =>
    setSelected((old) => {
      const s = new Set(old);
      const all = visible.every((t) => s.has(t.path));
      for (const t of visible) {
        if (all) s.delete(t.path);
        else s.add(t.path);
      }
      return s;
    });
  const restore = async (op: Operation) => {
    if (
      !(await confirm(
        `Restore the original bytes for ${filename(op.source)}? GainMate refuses if the current file or backup has changed.`,
        { title: 'Restore original', kind: 'warning' },
      ))
    )
      return;
    setWorking(true);
    try {
      await invoke('restore_backup', { id: op.id });
      refreshHistory();
      setTracks((old) =>
        old.map((t) =>
          t.path === op.source ? { path: t.path, state: 'queued' } : t,
        ),
      );
      setActive(null);
    } catch (e) {
      showError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const closeExport = useCallback(() => setExporting(false), []),
    closeRekordbox = useCallback(() => setRekordbox(null), []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="window-drag" data-tauri-drag-region />
        <div className="brand">
          <Logo />
          <div>
            GainMate<span>LOUDNESS PROCESSOR</span>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <button
            className={page === 'collection' ? 'active' : ''}
            onClick={() => setPage('collection')}
          >
            <Library size={17} />
            Collection<span className="nav-count">{tracks.length || ''}</span>
          </button>
          <button
            className={page === 'history' ? 'active' : ''}
            onClick={() => {
              setPage('history');
              refreshHistory();
            }}
          >
            <History size={17} />
            History{operations.length > 0 && <span className="history-dot" />}
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="workspace-label">ADD TO COLLECTION</div>
        <button
          className="sidebar-action"
          disabled={busy}
          onClick={() => pick('files')}
        >
          <FileAudio size={16} />
          Import files<small>⌘ O</small>
        </button>
        <button
          className="sidebar-action"
          disabled={busy}
          onClick={() => pick('folder')}
        >
          <FolderOpen size={16} />
          Import folder
        </button>
        <button
          className="sidebar-action"
          disabled={busy}
          onClick={() => pick('xml')}
        >
          <Disc3 size={16} />
          Rekordbox XML
        </button>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={17} />
            <span>
              Local processing<small>No network required</small>
            </span>
          </div>
          <button
            className={`sidebar-action ${page === 'guide' ? 'accent' : ''}`}
            onClick={() => setPage('guide')}
          >
            <CircleHelp size={16} />
            Documentation
            <ChevronRight size={13} />
          </button>
          <div className="version">
            <span>GAINMATE</span>
            <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar" data-tauri-drag-region>
          <div className="breadcrumb">
            Workspace <ChevronRight size={12} />
            <span>
              {page === 'collection'
                ? 'Collection'
                : page === 'history'
                  ? 'Operation history'
                  : 'Loudness guide'}
            </span>
          </div>
          <div className="engine-status">
            <i /> Local audio engine
          </div>
        </header>
        {error && (
          <div className="notification" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setError('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {page === 'collection' ? (
          <div className="workspace">
            <main className={`collection ${tracks.length ? 'has-tracks' : ''}`}>
              <div className="collection-heading">
                <div>
                  <div className="eyebrow">LIBRARY / LOUDNESS ANALYSIS</div>
                  <h1>{tracks.length ? 'Audio Library' : 'Audio Library'}</h1>
                  <p>
                    {tracks.length
                      ? 'Integrated loudness, peak levels and processing status.'
                      : 'Import tracks to measure loudness and prepare normalization.'}
                  </p>
                </div>
                {tracks.length > 0 && (
                  <div className="import-dropdown">
                    <button
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => setImportMenu(!importMenu)}
                    >
                      <Plus size={15} />
                      Add tracks
                      <ChevronDown size={13} />
                    </button>
                    {importMenu && (
                      <div className="dropdown-menu">
                        <button onClick={() => pick('files')}>
                          Audio files
                        </button>
                        <button onClick={() => pick('folder')}>Folder</button>
                        <button onClick={() => pick('xml')}>
                          Rekordbox XML
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {!tracks.length ? (
                <>
                  <div className={`dropzone ${dragging ? 'dragging' : ''}`}>
                    <div className="drop-graphic">
                      <AudioLines size={62} />
                    </div>
                    <h2>No tracks loaded</h2>
                    <p>Drop audio files or folders here.</p>
                    <span className="format-pills">
                      <b>MP3</b>
                      <b>WAV</b>
                      <b>FLAC</b>
                    </span>
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => pick('files')}
                    >
                      <Plus size={16} />
                      Add audio files
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => pick('folder')}
                    >
                      Select folder
                      <ArrowRight size={13} />
                    </button>
                  </div>
                  <div className="welcome-bottom">
                    <div>
                      <Activity size={20} />
                      <strong>Analysis</strong>
                      <p>Integrated LUFS · LRA · True peak</p>
                    </div>
                    <div>
                      <SlidersHorizontal size={20} />
                      <strong>Processing</strong>
                      <p>Uniform gain or peak-limited normalization</p>
                    </div>
                    <div>
                      <ShieldCheck size={20} />
                      <strong>Output verification</strong>
                      <p>Loudness · Peak ceiling · Sample count</p>
                    </div>
                  </div>
                  {recent.length > 0 && (
                    <button
                      className="recent-session"
                      disabled={busy}
                      onClick={() => importLocations(recent)}
                    >
                      <Clock3 size={15} />
                      Reopen last collection
                      <span>
                        {recent.length} tracks
                        <ArrowRight size={13} />
                      </span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <div className="collection-stats">
                    <div>
                      <span>ANALYZED TRACKS</span>
                      <strong>
                        {values.length}
                        <small>/ {tracks.length}</small>
                      </strong>
                    </div>
                    <div>
                      <span>MEDIAN LOUDNESS</span>
                      <strong>
                        {db(median(values))}
                        <small>LUFS</small>
                      </strong>
                    </div>
                    <div>
                      <span>COLLECTION SPREAD</span>
                      <strong>
                        {values.length
                          ? db(Math.max(...values) - Math.min(...values))
                          : '—'}
                        <small>LU</small>
                      </strong>
                    </div>
                    <div>
                      <span>NEED LIMITING</span>
                      <strong className={limitingCount ? 'sand' : ''}>
                        {limitingCount}
                        <small>tracks</small>
                      </strong>
                    </div>
                  </div>
                  <Histogram values={values} target={settings.target} />
                  <div className="table-toolbar">
                    <div className="track-tabs">
                      <button
                        className={filter === 'all' ? 'active' : ''}
                        onClick={() => setFilter('all')}
                      >
                        All tracks <span>{tracks.length}</span>
                      </button>
                      <button
                        className={filter === 'limiting' ? 'active' : ''}
                        onClick={() => setFilter('limiting')}
                      >
                        Need limiting
                      </button>
                      <button
                        className={filter === 'errors' ? 'active' : ''}
                        onClick={() => setFilter('errors')}
                      >
                        Errors{' '}
                        <span>
                          {tracks.filter((t) => t.state === 'error').length ||
                            ''}
                        </span>
                      </button>
                      <button
                        className={filter === 'verified' ? 'active' : ''}
                        onClick={() => setFilter('verified')}
                      >
                        Verified
                      </button>
                    </div>
                    <label className="search">
                      <Search size={14} />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Find a track…"
                        aria-label="Search collection"
                      />
                    </label>
                  </div>
                  <TrackTable
                    tracks={visible}
                    selected={selected}
                    active={active}
                    settings={settings}
                    toggle={toggle}
                    toggleAll={toggleAll}
                    onActive={setActive}
                    remove={remove}
                    sort={sort}
                    desc={desc}
                    onSort={(key) => {
                      if (sort === key) setDesc(!desc);
                      else {
                        setSort(key);
                        setDesc(false);
                      }
                    }}
                    busy={busy}
                  />
                  <div className="table-footer">
                    <span>
                      {selected.size} of {tracks.length} selected
                    </span>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        runAnalysis(
                          tracks
                            .filter((t) => selected.has(t.path))
                            .map((t) => t.path),
                        )
                      }
                    >
                      <RotateCcw size={12} />
                      Analyze selection
                    </button>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setTracks([]);
                        setSelected(new Set());
                        setActive(null);
                        void invoke('save_session', { paths: [] }).catch((e) =>
                          showError(String(e)),
                        );
                      }}
                    >
                      Clear collection
                    </button>
                  </div>
                  {selectedTrack?.analysis && (
                    <DetailPanel
                      key={selectedTrack.path}
                      track={selectedTrack}
                      settings={settings}
                      close={() => setActive(null)}
                      onError={showError}
                    />
                  )}
                </>
              )}
            </main>
            <aside className="settings-panel">
              <div className="panel-heading">
                <Settings2 size={16} />
                <span>NORMALIZATION</span>
              </div>
              <div className="target-block">
                <div className="field-label">TARGET LOUDNESS</div>
                <div className="target-value">
                  {db(settings.target, settings.target % 1 === 0 ? 0 : 1)}
                  <span>LUFS</span>
                </div>
                <input
                  aria-label="Target loudness"
                  type="range"
                  min="-36"
                  max="-6"
                  step="0.5"
                  value={settings.target}
                  disabled={busy}
                  onChange={(e) =>
                    setSettings({ ...settings, target: +e.target.value })
                  }
                />
                <div className="range-labels">
                  <span>More headroom</span>
                  <span>Louder</span>
                </div>
                <div className="target-presets">
                  {[-18, -14, -12, -9].map((value) => (
                    <button
                      disabled={busy}
                      key={value}
                      className={settings.target === value ? 'active' : ''}
                      onClick={() =>
                        setSettings({ ...settings, target: value })
                      }
                    >
                      {value}
                    </button>
                  ))}
                </div>
                <p>
                  Default: −12 LUFS.
                  <br />
                  Adjust to suit the material.
                </p>
              </div>
              <div className="panel-section">
                <div className="field-label">PROCESSING MODE</div>
                <button
                  disabled={busy}
                  className={`mode-choice ${settings.mode === 'precise' ? 'selected' : ''}`}
                  onClick={() => setSettings({ ...settings, mode: 'precise' })}
                >
                  <span className="radio-mark" />
                  <div>
                    <strong>
                      Precise Normalize <span>DEFAULT</span>
                    </strong>
                    <p>
                      Match the target. Manage peaks with limiting when needed.
                    </p>
                  </div>
                </button>
                <button
                  disabled={busy}
                  className={`mode-choice ${settings.mode === 'safe' ? 'selected' : ''}`}
                  onClick={() => setSettings({ ...settings, mode: 'safe' })}
                >
                  <span className="radio-mark" />
                  <div>
                    <strong>Safe Gain</strong>
                    <p>
                      Keep all dynamics. Stop below the target if peaks need
                      room.
                    </p>
                  </div>
                </button>
              </div>
              <div className="panel-section peak-section">
                <div>
                  <label className="field-label" htmlFor="ceiling">
                    TRUE PEAK CEILING
                  </label>
                  <span>Maximum verified output level.</span>
                </div>
                <div className="number-unit">
                  <input
                    id="ceiling"
                    type="number"
                    min="-9"
                    max="0"
                    step="0.1"
                    value={settings.ceiling}
                    disabled={busy}
                    onChange={(e) => {
                      const n = +e.target.value;
                      if (n >= -9 && n <= 0)
                        setSettings({ ...settings, ceiling: n });
                    }}
                  />
                  <span>dBTP</span>
                </div>
              </div>
              <div className="processing-note">
                <ShieldCheck size={17} />
                <p>
                  Output checks enabled
                  <span>
                    LUFS, true peak and timing are verified after encoding.
                  </span>
                </p>
              </div>
              <div className="normalize-action">
                <div className="selection-recap">
                  <CheckCheck size={15} />
                  <span>{chosen.length} tracks ready</span>
                </div>
                <button
                  className="primary-button"
                  disabled={!chosen.length || busy}
                  onClick={review}
                >
                  Review export
                  <ArrowRight size={17} />
                </button>
                <span className="shortcut-note">
                  ⌘ ↵ &nbsp; · &nbsp; Originals are kept by default
                </span>
              </div>
            </aside>
          </div>
        ) : page === 'history' ? (
          <main className="history-page">
            <div className="eyebrow">PROCESSING LOG</div>
            <h1>History</h1>
            <p>Verified results and original backups, all in one place.</p>
            {!operations.length ? (
              <div className="page-empty">
                <History size={36} />
                <h2>No operations recorded</h2>
                <p>Your completed exports and backups will appear here.</p>
              </div>
            ) : (
              <div className="history-list">
                {operations.map((op) => (
                  <article key={op.id}>
                    <div className="history-icon">
                      {op.status === 'restored' ? (
                        <RotateCcw size={19} />
                      ) : op.status === 'failed' ||
                        op.status === 'cancelled' ? (
                        <CircleAlert size={19} />
                      ) : (
                        <Check size={19} />
                      )}
                    </div>
                    <div className="history-file">
                      <strong>{filename(op.source)}</strong>
                      <span>
                        {new Date(op.timestamp * 1000).toLocaleString()} ·{' '}
                        {op.status}
                      </span>
                      <small title={op.output}>{op.output}</small>
                    </div>
                    <div className="history-result">
                      <span>
                        {db(op.before)}
                        <ArrowRight size={13} />
                        <strong>{db(op.after)} LUFS</strong>
                      </span>
                      <small>
                        {db(op.truePeak)} dBTP · {op.message}
                      </small>
                    </div>
                    {op.backup &&
                      ['complete', 'prepared'].includes(op.status) && (
                        <button
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => restore(op)}
                        >
                          <RotateCcw size={13} />
                          Restore
                        </button>
                      )}
                  </article>
                ))}
              </div>
            )}
          </main>
        ) : (
          <main className="guide-page">
            <div className="eyebrow">REFERENCE</div>
            <h1>Processing reference</h1>
            <p className="guide-lead">
              Measurement standards, processing modes and file handling.
            </p>
            <div className="guide-grid">
              <article>
                <Activity />
                <h2>Loudness analysis</h2>
                <p>
                  Import audio files, folders or a Rekordbox XML export.
                  Analysis measures integrated LUFS, true peak, sample peak and
                  loudness range using EBU R128. The histogram shows loudness,
                  while the waveform shows amplitude.
                </p>
              </article>
              <article>
                <SlidersHorizontal />
                <h2>Target loudness</h2>
                <p>
                  −12 LUFS is a starting point, not a DJ standard. Try a quieter
                  target for more headroom and less processing. Change the
                  target freely; predictions update without decoding again.
                </p>
              </article>
              <article>
                <Sparkles />
                <h2>Precise Normalize</h2>
                <p>
                  Precise Normalize applies uniform gain when possible. If peaks
                  need control, an oversampled loudness processor limits them.
                  More than 6 dB of predicted peak reduction is refused.
                  Verified output must be within 0.3 LU of the target.
                </p>
              </article>
              <article>
                <ShieldCheck />
                <h2>Safe Gain</h2>
                <p>
                  Safe Gain applies a single gain value, without limiting or
                  compression. It may finish below your target. The verified
                  result shows the actual loudness and never calls an
                  unreachable target a match.
                </p>
              </article>
              <article>
                <Disc3 />
                <h2>MP3 encoding</h2>
                <p>
                  MP3 is decoded and encoded using LAME V0. That adds a lossy
                  generation. MP3Gain frame adjustments are coarse (about 1.5
                  dB), cannot perform true peak limiting, and are not
                  implemented here. WAV and FLAC avoid lossy encoding.
                </p>
              </article>
              <article>
                <FolderOpen />
                <h2>File safety and metadata</h2>
                <p>
                  Exports never overwrite existing files. Replacing originals
                  requires explicit review, with byte-for-byte backups enabled
                  by default. Standard tags and MP3/FLAC artwork are copied;
                  proprietary tags, WAV chunks, cue data and filesystem
                  attributes may not survive. Rekordbox may need to reanalyze
                  modified files.
                </p>
              </article>
            </div>
            <div className="guide-keyboard">
              <strong>Keyboard shortcuts</strong>
              <span>⌘ / Ctrl O · Import files</span>
              <span>⇧ ⌘ / Ctrl O · Folder</span>
              <span>⌘ / Ctrl A · Select all</span>
              <span>⌘ / Ctrl ↵ · Review export</span>
            </div>
          </main>
        )}
        <footer className="statusbar">
          <span>
            <span className={`status-light ${busy ? 'pulsing' : ''}`} />
            {busy
              ? progress?.phase || 'Working'
              : cancelled
                ? 'Cancelled · completed files are safe'
                : progress && progress.completed === progress.total
                  ? `${progress.completed} tracks finished`
                  : 'Engine idle'}
          </span>
          {busy && progress ? (
            <>
              <div className="job-progress">
                <div
                  style={{
                    width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className="current-file" title={progress.path || ''}>
                {progress.path ? filename(progress.path) : ''}
              </span>
              <span>
                {progress.completed} / {progress.total}
              </span>
              <button
                className="text-button"
                onClick={() => {
                  setCancelled(true);
                  void invoke('cancel_job');
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <span className="footer-right">
              <ShieldCheck size={12} />
              Local processing<span>EBU R128 / ITU-R BS.1770</span>
            </span>
          )}
        </footer>
      </div>
      {dragging && (
        <div className="drag-overlay">
          <Upload size={44} />
          <h2>Import audio</h2>
          <p>MP3, WAV, FLAC and folders</p>
        </div>
      )}
      {exporting && (
        <ExportDialog
          paths={chosen}
          settings={settings}
          setSettings={setSettings}
          close={closeExport}
          start={normalized}
          onError={showError}
        />
      )}{' '}
      {rekordbox && (
        <RekordboxDialog
          library={rekordbox}
          close={closeRekordbox}
          importTracks={(paths) => {
            setRekordbox(null);
            void importLocations(paths);
          }}
        />
      )}
      {busy && !progress && (
        <div className="working-toast">
          <LoaderCircle size={16} className="spin" />
          Reading your library…
        </div>
      )}
    </div>
  );
}
