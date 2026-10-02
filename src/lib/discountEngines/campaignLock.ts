/**
 * The metafield key naming the campaign that owns a discount.
 *
 * Written inside whichever `$app:discount-*` namespace the engine already
 * uses, as a SEPARATE metafield from `config`: that config is deserialised by
 * the deployed Rust functions on every cart and carries a 10 KB cap, so a key
 * added there risks a function that prices real carts. A key here cannot —
 * no function reads it.
 *
 * This module is a leaf on purpose. It is imported by the Worker that writes
 * the value AND by the three admin UI extensions that read it, so it must
 * carry no Worker-only dependency: pulling `adminGraphql` or the Cloudflare
 * `Env` into an extension bundle through this import would break the build.
 *
 * One copy of the key, for the same reason there is one copy of the wire
 * format: a mismatch between writer and reader finds nothing, silently, and
 * the settings UI would stay editable with no sign anything was wrong.
 */
export const CAMPAIGN_METAFIELD_KEY = 'campaign';
