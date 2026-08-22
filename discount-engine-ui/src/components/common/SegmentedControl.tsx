import { Button, ButtonGroup } from '@shopify/polaris';

/** A small segmented control built on Polaris' segmented ButtonGroup. */
export function SegmentedControl({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: number;
  onChange: (index: number) => void;
}) {
  return (
    <ButtonGroup variant="segmented">
      {options.map((option, i) => (
        <Button key={option} pressed={i === selected} onClick={() => onChange(i)}>
          {option}
        </Button>
      ))}
    </ButtonGroup>
  );
}
