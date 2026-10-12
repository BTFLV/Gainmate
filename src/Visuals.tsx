import { useId } from 'react';
import { db, distribution } from './audio';
import type { Analysis } from './types';
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="3" fill="#ffd600" />
      <path
        d="M10 17v6m6-12v18m8-15v12m6-9v6"
        stroke="#191919"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <path d="M8 20h24" stroke="#191919" strokeWidth="1.5" opacity=".3" />
    </svg>
  );
}
export function Waveform({
  data,
  large = false,
  progress = 0,
  onSeek,
}: {
  data: number[];
  large?: boolean;
  progress?: number;
  onSeek?: (fraction: number) => void;
}) {
  const count = large ? 240 : 40;
  const step = Math.max(1, Math.ceil(data.length / count));
  const values = [];
  for (let i = 0; i < data.length; i += step)
    values.push(Math.max(...data.slice(i, i + step)));
  const max = Math.max(...values, 0.02);
  return (
    <svg
      className={`waveform ${large ? 'large' : ''}`}
      viewBox={`0 0 ${values.length * 3 || 120} 60`}
      preserveAspectRatio="none"
      aria-label="Amplitude waveform"
      role={onSeek ? 'slider' : 'img'}
      tabIndex={onSeek ? 0 : undefined}
      aria-valuemin={onSeek ? 0 : undefined}
      aria-valuemax={onSeek ? 100 : undefined}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      onKeyDown={(e) => {
        if (onSeek && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          onSeek(
            Math.max(
              0,
              Math.min(1, progress + (e.key === 'ArrowRight' ? 0.02 : -0.02)),
            ),
          );
        }
      }}
      onClick={(e) => {
        if (onSeek) {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek((e.clientX - r.left) / r.width);
        }
      }}
    >
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * 3}
          y={30 - Math.max(1, (v / max) * 27)}
          width="1.7"
          height={Math.max(2, (v / max) * 54)}
          rx=".8"
          fill={i / values.length < progress ? '#ffd600' : 'currentColor'}
          opacity={large ? 0.85 : 0.6}
        />
      ))}
    </svg>
  );
}
export function Histogram({
  values,
  target,
}: {
  values: number[];
  target: number;
}) {
  const id = useId();
  const bins = distribution(values);
  const max = Math.max(...bins, 1);
  const x = ((Math.max(-36, Math.min(-4, target)) + 36) / 32) * 900;
  return (
    <div className="histogram">
      <div className="chart-label">
        <span>LOUDNESS DISTRIBUTION</span>
        <span>
          <i className="legend-dot" />
          Original loudness <i className="legend-target" />
          Target {db(target)} LUFS
        </span>
      </div>
      <svg
        viewBox="0 0 940 130"
        preserveAspectRatio="none"
        aria-label={`Loudness distribution of ${values.length} tracks, target ${target} LUFS`}
        role="img"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#ffd600" />
            <stop offset="1" stopColor="#6b6b6b" />
          </linearGradient>
        </defs>
        {[0, 1, 2].map((i) => (
          <line
            key={i}
            x1="20"
            y1={20 + i * 38}
            x2="920"
            y2={20 + i * 38}
            stroke="#343434"
            strokeDasharray="2 5"
          />
        ))}
        {bins.map((b, i) => (
          <g key={i}>
            <title>
              {i - 36} to {i - 35} LUFS: {b} tracks
            </title>
            <rect
              x={20 + (i * 900) / 32 + 3}
              y={100 - (b / max) * 80}
              width="22"
              height={(b / max) * 80 || 1}
              rx="3"
              fill={i - 36 >= target ? '#ffd600' : `url(#${id})`}
              opacity={b ? 1 : 0.25}
            />
          </g>
        ))}
        <line
          x1={20 + x}
          x2={20 + x}
          y1="3"
          y2="102"
          stroke="#ffd600"
          strokeDasharray="4 4"
        />
        <path d={`M${16 + x} 0h8l-4 6z`} fill="#ffd600" />
        {[-36, -30, -24, -18, -12, -6].map((v) => (
          <text
            key={v}
            x={20 + ((v + 36) / 32) * 900}
            y="124"
            fill="#b4b4b4"
            fontSize="10"
            textAnchor="middle"
          >
            {v}
          </text>
        ))}
      </svg>
    </div>
  );
}
export function LoudnessChart({
  analysis,
  target,
}: {
  analysis: Analysis;
  target: number;
}) {
  const points = analysis.timeline.filter((p) => p.shortTerm != null);
  const y = (v: number) => Math.max(2, Math.min(88, ((0 - v) / 48) * 90));
  return (
    <svg
      viewBox="0 0 800 100"
      preserveAspectRatio="none"
      className="loudness-chart"
      role="img"
      aria-label="Short-term loudness over time, three-second window"
    >
      <line
        x1="0"
        x2="800"
        y1={y(target)}
        y2={y(target)}
        stroke="#ffd600"
        opacity=".5"
        strokeDasharray="4 4"
      />
      <polyline
        fill="none"
        stroke="#ffd600"
        strokeWidth="1.6"
        points={points
          .map(
            (p) =>
              `${(p.time / analysis.info.duration) * 800},${y(p.shortTerm!)}`,
          )
          .join(' ')}
      />
      <text x="4" y="98" fill="#aaaaaa" fontSize="9">
        0:00
      </text>
      <text x="750" y="98" fill="#aaaaaa" fontSize="9">
        {Math.floor(analysis.info.duration / 60)}:
        {Math.floor(analysis.info.duration % 60)
          .toString()
          .padStart(2, '0')}
      </text>
    </svg>
  );
}
