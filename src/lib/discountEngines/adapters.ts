import * as tier from './tier';
import * as bundle from './bundle';
import * as special from './special';

export type DiscountEngineType = 'tier' | 'bundle' | 'special';

/**
 * The interface the three engine modules already share, named.
 *
 * They arrived at it independently — each exports build/validate/size/parse
 * over its own form shape — so this adds no logic. What it adds is a single
 * dispatch point, so the create route never branches on discount type and a
 * fourth engine is one entry in the registry below.
 */
export interface DiscountEngineAdapter<TForm> {
  type: DiscountEngineType;
  /** Extension handle from shopify.extension.toml; resolves to a functionId. */
  functionHandle: string;
  /** The `$app:` metafield namespace the Rust function reads. */
  namespace: string;
  key: 'config';
  maxBytes: number;

  validate(form: TForm): string[];
  /** Throws on an unserialisable form — see the note in `serialize` below. */
  serialize(form: TForm): string;
  sizeBytes(form: TForm): number;
  /**
   * Does the BUILT config actually carry a rule the Rust function will act on?
   *
   * `validate` reads the FORM; `buildXConfig` independently drops entries it
   * cannot resolve (an empty id list, a target the selector type does not
   * reach). The two can disagree, and the gap is silent: a form that validates
   * serialises to a config with an empty rule collection, the mutation
   * succeeds, and a real automatic discount does nothing at checkout.
   *
   * This closes the gap on the built side, where the function's own reading is.
   */
  isActionable(built: unknown): boolean;
}

/**
 * `getMetafieldValueString` catches its own errors and returns "{}". That is
 * tolerable in the extension, where the merchant is looking at the form, and
 * dangerous here: the server would create a REAL discount carrying an empty
 * configuration, which the function reads as "no rules" — a promotion that
 * silently does nothing at checkout, with no error anywhere.
 *
 * So serialization goes through `buildX` + `JSON.stringify` directly and is
 * allowed to throw.
 */
function serializer<TForm>(build: (form: TForm) => unknown) {
  return (form: TForm): string => JSON.stringify(build(form));
}

/** True when `built` has a non-empty array at `key` — bundle and special both
 *  emit their rules as an array. */
function hasRules(built: unknown, key: string): boolean {
  if (typeof built !== 'object' || built === null) return false;
  const rules = (built as Record<string, unknown>)[key];
  return Array.isArray(rules) && rules.length > 0;
}

/**
 * Tier's rules are an OBJECT keyed by the discount magnitude, and
 * `engine.rs:127` skips any key that does not `parse::<f64>()`. So an empty
 * `discount_tiers` and one whose every key is non-numeric are the same
 * no-op, and both are unactionable here.
 */
function hasNumericTiers(built: unknown): boolean {
  if (typeof built !== 'object' || built === null) return false;
  const tiers = (built as Record<string, unknown>).discount_tiers;
  if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers)) return false;
  return Object.keys(tiers).some((key) => key.trim() !== '' && Number.isFinite(Number(key)));
}

const tierAdapter: DiscountEngineAdapter<tier.TierFormData> = {
  type: 'tier',
  functionHandle: 'discount-tier',
  namespace: tier.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: tier.METAFIELD_MAX_SIZE_BYTES,
  validate: tier.validateTierConfig,
  serialize: serializer(tier.buildTierConfig),
  isActionable: hasNumericTiers,
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

const bundleAdapter: DiscountEngineAdapter<bundle.BundleFormData> = {
  type: 'bundle',
  functionHandle: 'discount-bundle',
  namespace: bundle.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: bundle.METAFIELD_MAX_SIZE_BYTES,
  validate: bundle.validateBundleConfig,
  serialize: serializer(bundle.buildBundleConfig),
  isActionable: (built) => hasRules(built, 'bundle_discounts'),
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

const specialAdapter: DiscountEngineAdapter<special.SpecialFormData> = {
  type: 'special',
  functionHandle: 'discount-special',
  namespace: special.METAFIELD_NAMESPACE,
  key: 'config',
  maxBytes: special.METAFIELD_MAX_SIZE_BYTES,
  validate: special.validateSpecialConfig,
  serialize: serializer(special.buildSpecialConfig),
  isActionable: (built) => hasRules(built, 'special_discounts'),
  sizeBytes(form) {
    return new TextEncoder().encode(this.serialize(form)).length;
  },
};

export const ENGINE_ADAPTERS = {
  tier: tierAdapter,
  bundle: bundleAdapter,
  special: specialAdapter,
} as unknown as Record<DiscountEngineType, DiscountEngineAdapter<never>>;

/** Throws rather than returning undefined: an unknown engine means a corrupt
 *  template row, and continuing would write config no function reads. */
export function getAdapter(type: DiscountEngineType): DiscountEngineAdapter<never> {
  const adapter = ENGINE_ADAPTERS[type];
  if (!adapter) throw new Error(`[discountEngines] unknown engine type: ${type}`);
  return adapter;
}
