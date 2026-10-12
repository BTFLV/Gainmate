export interface AudioInfo {
  sampleRate: number;
  channels: number;
  channelLayout: string;
  codec: string;
  bitDepth: number;
  format: string;
  duration: number;
  title: string;
  artist: string;
  album: string;
  hasArtwork: boolean;
  tags: Record<string, string>;
}
export interface Analysis {
  path: string;
  fingerprint: { bytes: number; modifiedNs: number };
  info: AudioInfo;
  integrated: number | null;
  truePeak: number | null;
  samplePeak: number | null;
  lra: number;
  threshold: number | null;
  waveform: number[];
  timeline: {
    time: number;
    shortTerm: number | null;
    momentary: number | null;
  }[];
  frames: number;
  warnings: string[];
}
export interface Settings {
  target: number;
  ceiling: number;
  mode: 'precise' | 'safe';
  destination: string | null;
  replace: boolean;
  backup: boolean;
  backupDirectory: string | null;
  preserveFolders: boolean;
}
export const defaultSettings: Settings = {
  target: -12,
  ceiling: -1,
  mode: 'precise',
  destination: null,
  replace: false,
  backup: true,
  backupDirectory: null,
  preserveFolders: true,
};
export interface Prediction {
  gain: number;
  output: number;
  limiting: number;
  strategy: string;
  warning: string | null;
}
export interface Plan {
  items: {
    source: string;
    output: string;
    prediction: Prediction | null;
    skip: string | null;
  }[];
  creates: number;
  overwrites: number;
  backups: number;
  skips: number;
}
export interface Operation {
  id: string;
  timestamp: number;
  source: string;
  output: string;
  backup: string | null;
  originalHash: string;
  outputHash: string;
  before: number | null;
  after: number | null;
  truePeak: number | null;
  target: number;
  targetReached: boolean;
  status: string;
  message: string;
  mode: 'precise' | 'safe';
}
export interface Track {
  path: string;
  analysis?: Analysis;
  state: 'queued' | 'ready' | 'error' | 'done';
  error?: string;
  operation?: Operation;
}
export interface Progress {
  phase: string;
  completed: number;
  total: number;
  path: string | null;
}
export interface TrackEvent {
  path: string;
  analysis: Analysis | null;
  operation: Operation | null;
  error: string | null;
}
export interface Rekordbox {
  tracks: {
    id: string;
    title: string;
    artist: string;
    path: string | null;
    missing: boolean;
  }[];
  playlists: { name: string; trackIds: string[] }[];
}
