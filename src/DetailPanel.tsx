import { useEffect, useRef, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Pause, Play, Volume2, X } from 'lucide-react';
import { db, duration, prediction, signed } from './audio';
import { LoudnessChart, Waveform } from './Visuals';
import type { Analysis, Settings, Track } from './types';
export default function DetailPanel({
  track,
  settings,
  close,
  onError,
}: {
  track: Track;
  settings: Settings;
  close: () => void;
  onError: (s: string) => void;
}) {
  const [detail, setDetail] = useState<Analysis | null>(null),
    [tab, setTab] = useState<'waveform' | 'loudness'>('waveform'),
    [version, setVersion] = useState<'original' | 'processed'>('original'),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [volume, setVolume] = useState(0.75);
  const audio = useRef<HTMLAudioElement>(null);
  const seekAfterLoad = useRef(0);
  useEffect(() => {
    let current = true;
    invoke<Analysis>('track_detail', { path: track.path })
      .then((a) => {
        if (current) setDetail(a);
      })
      .catch((e) => {
        if (current) onError(String(e));
      });
    return () => {
      current = false;
    };
  }, [track.path, track.operation, onError]);
  const a = detail ?? track.analysis;
  if (!a) return null;
  const guess = prediction(a, settings);
  const original =
    track.operation?.output === track.path
      ? track.operation.backup
      : track.path;
  const path = version === 'processed' ? track.operation?.output : original;
  const switchVersion = (v: 'original' | 'processed') => {
    seekAfterLoad.current = audio.current?.currentTime ?? 0;
    audio.current?.pause();
    setPlaying(false);
    setVersion(v);
  };
  return (
    <section className="detail-panel">
      <div className="detail-heading">
        <div>
          <strong>{a.info.title}</strong>
          <span>
            {a.info.format.toUpperCase()} ·{' '}
            {(a.info.sampleRate / 1000).toFixed(1)} kHz ·{' '}
            {a.info.bitDepth ? `${a.info.bitDepth}-bit · ` : ''}
            {a.info.channelLayout}
          </span>
        </div>
        <div className="segmented small">
          <button
            className={tab === 'waveform' ? 'active' : ''}
            onClick={() => setTab('waveform')}
          >
            Waveform
          </button>
          <button
            className={tab === 'loudness' ? 'active' : ''}
            onClick={() => setTab('loudness')}
          >
            Short-term LUFS
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="Close track details"
          onClick={close}
        >
          <X size={16} />
        </button>
      </div>
      <div className="detail-body">
        <div className="detail-visual">
          {tab === 'waveform' ? (
            <Waveform
              data={a.waveform}
              large
              progress={time / a.info.duration}
              onSeek={(fraction) => {
                if (audio.current) {
                  audio.current.currentTime = fraction * a.info.duration;
                  setTime(audio.current.currentTime);
                }
              }}
            />
          ) : (
            <LoudnessChart analysis={a} target={settings.target} />
          )}
          <div className="playback">
            <button
              className="play-button"
              disabled={!path}
              aria-label={playing ? 'Pause preview' : 'Play preview'}
              onClick={() => {
                if (!audio.current) return;
                if (playing) audio.current.pause();
                else
                  audio.current
                    .play()
                    .catch(() =>
                      onError(
                        'This system cannot preview this encoding. Analysis and export remain available.',
                      ),
                    );
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <span className="mono">
              {duration(time)} <em>/ {duration(a.info.duration)}</em>
            </span>
            <div className="segmented small ab">
              <button
                disabled={!original}
                onClick={() => switchVersion('original')}
                className={version === 'original' ? 'active' : ''}
              >
                A · Original
              </button>
              <button
                disabled={!track.operation}
                onClick={() => switchVersion('processed')}
                className={version === 'processed' ? 'active' : ''}
              >
                B · Processed
              </button>
            </div>
            <Volume2 size={13} />
            <input
              type="range"
              aria-label="Preview volume"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => {
                setVolume(+e.target.value);
                if (audio.current) audio.current.volume = +e.target.value;
              }}
            />
          </div>
          {path && (
            <audio
              ref={audio}
              src={convertFileSrc(path)}
              onLoadedMetadata={() => {
                if (audio.current) {
                  audio.current.currentTime = seekAfterLoad.current;
                  audio.current.volume = volume;
                }
              }}
              onTimeUpdate={() => setTime(audio.current?.currentTime ?? 0)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              preload="metadata"
            />
          )}
        </div>
        <div className="detail-meters">
          <div>
            <span>Integrated</span>
            <strong>
              {db(a.integrated)} <small>LUFS</small>
            </strong>
          </div>
          <div>
            <span>Loudness range</span>
            <strong>
              {db(a.lra)} <small>LU</small>
            </strong>
          </div>
          <div>
            <span>True / sample peak</span>
            <strong>
              {db(a.truePeak)} / {db(a.samplePeak)}
            </strong>
          </div>
          <div>
            <span>
              {track.operation ? 'Verified output' : 'Estimated gain'}
            </span>
            <strong className="accent">
              {track.operation
                ? `${db(track.operation.after)} LUFS`
                : guess
                  ? `${signed(guess.gain)} dB`
                  : '—'}
            </strong>
          </div>
        </div>
      </div>
      {track.error ? (
        <div className="detail-note amber">{track.error}</div>
      ) : (
        <div className="detail-note">
          {guess?.limiting
            ? `Estimated peak reduction: ${db(guess.limiting)} dB. `
            : ''}
          {a.info.format === 'mp3'
            ? 'Processing MP3 creates a new lossy generation. '
            : ''}
          {a.warnings.join(' ')}
          {track.operation
            ? ' A/B uses the same playback volume; processed audio may intentionally be louder.'
            : 'Output loudness and peaks are measured again after encoding.'}
        </div>
      )}
    </section>
  );
}
