import { useId } from 'react';

/**
 * The ORBITT orbit mark: an open violet-to-blue ring with a planet in the gap,
 * drawn after the brand banner so it stays crisp at every size.
 */
export function OrbitMark({ size = 28, spinning = false, title }: { size?: number; spinning?: boolean; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className={`ob-orbit-mark${spinning ? ' is-spinning' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id={`ob-ring-${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset=".55" stopColor="#6f7ef8" />
          <stop offset="1" stopColor="#4ab4f8" />
        </linearGradient>
        <radialGradient id={`ob-dot-${id}`} cx=".35" cy=".35" r=".75">
          <stop offset="0" stopColor="#9fdcff" />
          <stop offset="1" stopColor="#3f9df0" />
        </radialGradient>
      </defs>
      <g className="ob-orbit-ring">
        <path d="M40.94 22.52A17 17 0 1 1 28.4 7.58" fill="none" stroke={`url(#ob-ring-${id})`} strokeWidth="4.4" strokeLinecap="round" />
        <circle cx="37.02" cy="13.07" r="3.7" fill={`url(#ob-dot-${id})`} />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 15 }: { size?: number }) {
  return (
    <span className="ob-wordmark" style={{ fontSize: size }}>
      ORBITT <b>PAY</b>
    </span>
  );
}

export function BrandLockup({ markSize = 26, wordSize = 14 }: { markSize?: number; wordSize?: number }) {
  return (
    <span className="ob-lockup">
      <OrbitMark size={markSize} />
      <Wordmark size={wordSize} />
    </span>
  );
}
