/**
 * Mark for the "Original Gangster" theme.
 *
 * Placeholder until `public/og.svg` lands - replace the paths below with that
 * file's contents. Inline rather than an `<img>` so it matches the Lucide icons
 * around it: sized by `size`, drawn in the current text colour, no request.
 */
export function OgMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9.5a3.5 3.5 0 1 0 0 5H13" />
    </svg>
  );
}
