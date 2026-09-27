// The engine's wire format now lives in one place, shared with the Worker that
// also writes this metafield (src/lib/discountEngines/bundle.ts). Two copies
// would drift, and the drift is silent: the app writes config the Rust
// function misreads and a real discount misprices at checkout.
export * from '../../../src/lib/discountEngines/bundle';
