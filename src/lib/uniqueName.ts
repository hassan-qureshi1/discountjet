/**
 * Making a cloned discount's title and code unique.
 *
 * Shopify requires both to be unique across a shop, and a clone starts life as
 * an exact copy of something already live — so without this every cloned
 * campaign fails to publish, on every discount. Clone is the only way to edit
 * a published campaign, so that failure takes the whole edit path with it.
 *
 * A fixed suffix is not enough. `"BFCM 1 (copy)"` collides on the SECOND
 * clone, which is precisely when a merchant is iterating on a campaign and
 * least expects to be stopped. Counting is what actually holds.
 */

/** `'BFCM 1'` -> `'BFCM 1 (2)'`, `'BFCM 1 (3)'`, … until one is free. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  // From 2, because the original is the first: a merchant reading "(2)"
  // understands the second copy, where "(1)" would suggest they lost one.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  // A thousand identically-named discounts is not a real shop; failing loudly
  // beats returning a name that is about to be rejected by Shopify anyway.
  throw new RangeError(`[uniqueName] no free name for "${base}" after 999 tries`);
}

/**
 * The same counting for a discount CODE, which a shopper types at checkout.
 *
 * Deliberately not `uniqueName`'s format: spaces and parentheses make a poor
 * code to print on a banner or read down a phone, so the suffix stays within
 * the characters a code is normally written in.
 */
export function uniqueCode(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new RangeError(`[uniqueCode] no free code for "${base}" after 999 tries`);
}
