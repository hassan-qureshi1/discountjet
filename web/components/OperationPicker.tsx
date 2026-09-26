import { useState } from 'react';
import { ActionList, Button, Popover } from '@shopify/polaris';
import { OPERATIONS, gateOperation } from '../bundles/ops';
import type { BundleOperation } from '../types/bundles';

/**
 * The one place an operation is chosen.
 *
 * The operation is the most consequential thing about a bundle — it decides
 * what the merchant is asked for next — so it is picked deliberately rather
 * than defaulted into. This component serves both moments: creating a bundle
 * from the list page, and changing one from inside the editor. Two spellings
 * of the same choice would be free to drift apart in wording and in gating.
 *
 * `update` is shown DISABLED for non-Plus stores rather than hidden. A
 * capability that silently isn't there reads as a missing feature; a disabled
 * row with a reason reads as a plan limit, which is what it is.
 */
export function OperationPicker({
  updateOpEligible,
  onSelect,
  label,
  variant = 'primary',
  selected,
  disabled = false,
}: {
  updateOpEligible: boolean;
  onSelect: (operation: BundleOperation) => void;
  label: string;
  variant?: 'primary' | 'plain';
  /** Marks the operation already in effect, so the list shows where you are. */
  selected?: BundleOperation;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const items = OPERATIONS.map((op) => {
    const gate = gateOperation(op.id, updateOpEligible);
    return {
      content: op.label,
      // The reason replaces the description when a row is unavailable: a
      // merchant who cannot pick it needs to know why, not what it would do.
      helpText: gate.enabled ? op.description : gate.reason,
      disabled: !gate.enabled,
      active: selected === op.id,
      onAction: () => {
        setOpen(false);
        onSelect(op.id);
      },
    };
  });

  return (
    <Popover
      active={open}
      autofocusTarget="first-node"
      onClose={() => setOpen(false)}
      activator={(
        <Button
          variant={variant}
          disclosure
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {label}
        </Button>
      )}
    >
      <ActionList actionRole="menuitem" items={items} />
    </Popover>
  );
}
