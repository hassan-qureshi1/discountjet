import { RadioButton } from '@shopify/polaris';
import type { ReactNode } from 'react';

/**
 * A bordered, selectable card wrapping a Polaris RadioButton — used for the
 * "how do you want to build it?" / "activate immediately vs schedule" choices.
 */
export function ChoiceCard({
  title,
  helpText,
  selected,
  onChange,
}: {
  title: string;
  helpText?: ReactNode;
  selected: boolean;
  onChange: () => void;
}) {
  return (
    <div
      onClick={onChange}
      style={{
        padding: '10px 12px',
        borderRadius: 10,
        marginBottom: 8,
        cursor: 'pointer',
        border: '1px solid var(--p-color-border)',
        boxShadow: selected ? 'inset 0 0 0 2px var(--p-color-border-brand)' : undefined,
        borderColor: selected ? 'transparent' : undefined,
      }}
    >
      <RadioButton
        label={title}
        helpText={helpText}
        checked={selected}
        onChange={onChange}
        id={title}
      />
    </div>
  );
}
