/**
 * A small square "thumbnail" showing a symbol or emoji, echoing the row icons
 * in the original design. Presentational leaf — the only place we hand-style,
 * using Polaris CSS custom properties so it tracks light/dark themes.
 */
export function SymbolTile({
  symbol,
  size = 34,
  emoji = false,
  brand = false,
}: {
  symbol: string;
  size?: number;
  emoji?: boolean;
  brand?: boolean;
}) {
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: 8,
        display: 'grid',
        placeItems: 'center',
        fontSize: emoji ? Math.round(size * 0.52) : Math.round(size * 0.44),
        lineHeight: 1,
        background: brand
          ? 'var(--p-color-bg-surface-brand)'
          : 'var(--p-color-bg-surface-secondary)',
        color: brand ? 'var(--p-color-text-brand)' : 'var(--p-color-text-secondary)',
        boxShadow: 'inset 0 0 0 1px var(--p-color-border)',
      }}
    >
      {symbol}
    </div>
  );
}
