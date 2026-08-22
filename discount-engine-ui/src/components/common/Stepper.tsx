import { Fragment } from 'react';

/**
 * Horizontal wizard stepper. Steps are clickable so the user can jump around
 * the flow. `current` is a 0-based index; steps before it render as "done".
 */
export function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: string[];
  current: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <Fragment key={label}>
            <button
              type="button"
              onClick={() => onSelect?.(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'none',
                border: 'none',
                cursor: onSelect ? 'pointer' : 'default',
                padding: '4px 2px',
                flex: '0 0 auto',
                fontFamily: 'inherit',
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 650,
                  flex: '0 0 auto',
                  background: active
                    ? 'var(--p-color-bg-fill-brand)'
                    : done
                      ? 'var(--p-color-bg-surface-brand)'
                      : 'var(--p-color-bg-surface-secondary)',
                  color: active
                    ? 'var(--p-color-text-brand-on-bg-fill)'
                    : done
                      ? 'var(--p-color-text-brand)'
                      : 'var(--p-color-text-secondary)',
                  boxShadow: active ? 'none' : 'inset 0 0 0 1px var(--p-color-border)',
                }}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: active ? 650 : 550,
                  whiteSpace: 'nowrap',
                  color: active || done ? 'var(--p-color-text)' : 'var(--p-color-text-secondary)',
                }}
              >
                {label}
              </span>
            </button>
            {i < steps.length - 1 && (
              <span
                style={{
                  flex: 1,
                  minWidth: 14,
                  height: 1,
                  background: 'var(--p-color-border)',
                  margin: '0 10px',
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
