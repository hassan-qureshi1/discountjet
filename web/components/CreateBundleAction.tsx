import { useState } from 'react';
import { ActionList, Button, Popover } from '@shopify/polaris';
import { OPERATIONS, gateOperation } from '../bundles/ops';
import type { BundleOperation } from '../types/bundles';

/**
 * "Create bundle" — a disclosure rather than a direct navigation.
 *
 * The operation is the single most consequential choice about a bundle: it
 * decides what the merchant is asked for next, and it is awkward to change
 * afterwards. Choosing it up front replaces an editor that opened on an
 * arbitrary default with one that opens already shaped for the job.
 *
 * `update` is shown DISABLED for non-Plus stores rather than hidden. A
 * capability that silently isn't there reads as a missing feature; a disabled
 * row with a reason reads as a plan limit, which is what it is.
 */
export function CreateBundleAction({
  updateOpEligible,
  onSelect,
  disabled = false,
}: {
  updateOpEligible: boolean;
  onSelect: (operation: BundleOperation) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const items = OPERATIONS.map((op) => {
    const gate = gateOperation(op.id, updateOpEligible);
    return {
      content: op.label,
      // The reason replaces the description when the row is unavailable: a
      // merchant who can't pick it needs to know why, not what it would do.
      helpText: gate.enabled ? op.description : gate.reason,
      disabled: !gate.enabled,
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
          variant="primary"
          disclosure
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          Create bundle
        </Button>
      )}
    >
      <ActionList actionRole="menuitem" items={items} />
    </Popover>
  );
}
