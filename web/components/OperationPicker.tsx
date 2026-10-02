import { useState } from 'react';
import { ActionList, Button, Popover } from '@shopify/polaris';
import { SELECTABLE_OPERATIONS, gateOperation } from '../bundles/ops';
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
 * It renders `SELECTABLE_OPERATIONS`, which currently excludes `update` — see
 * that constant for why. The Plus gate below still runs: it is what shows a
 * row DISABLED with a reason rather than hidden, because a capability that
 * silently isn't there reads as a missing feature while a disabled row with a
 * reason reads as a plan limit.
 */
export function OperationPicker({
  updateOpEligible,
  onSelect,
  label,
  planName,
  variant = 'primary',
  selected,
  disabled = false,
}: {
  updateOpEligible: boolean;
  onSelect: (operation: BundleOperation) => void;
  label: string;
  /** The shop's plan, so a disabled row can say which plan it is on. */
  planName?: string | null;
  variant?: 'primary' | 'plain';
  /** Marks the operation already in effect, so the list shows where you are. */
  selected?: BundleOperation;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const items = SELECTABLE_OPERATIONS.map((op) => {
    const gate = gateOperation(op.id, updateOpEligible, planName);
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
