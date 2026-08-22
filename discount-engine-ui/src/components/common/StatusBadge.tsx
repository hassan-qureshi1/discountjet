import { Badge } from '@shopify/polaris';
import type { Tone } from '../../types';

type BadgeTone = 'success' | 'info' | 'warning' | 'critical' | 'magic';

/**
 * Maps a domain `Tone` onto a Polaris Badge. 'neutral' renders the default
 * (tone-less) badge, which is what we want for "Ended"/"Inactive" states.
 */
export function StatusBadge({ label, tone }: { label: string; tone: Tone }) {
  const badgeTone = tone === 'neutral' ? undefined : (tone as BadgeTone);
  return <Badge tone={badgeTone}>{label}</Badge>;
}
