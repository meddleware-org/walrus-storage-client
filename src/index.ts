// Public API barrel for @meddleware/walrus-storage-client. Ships TypeScript source directly (the only build
// output is the `.d.ts` declarations in dist/). Grouped by concern: client factory + network config
// (client.ts), upload flows (upload.ts), blob lifetime/attribute management (manage.ts), owned-blob queries (query.ts), and
// access-gate-gateway relay access proofs (access.ts). Re-exports WalrusFile/RetryableWalrusClientError from
// @mysten/walrus for convenience.
//
// This file only re-exports. Anything not exported here is internal (`http.ts`'s relay transport and `flow.ts`'s upload state machine are reached through
// `createWalrusClient` and `uploadBytes`, not directly) and may change without notice.

// The client factory, the per-network defaults (RPC, relay and aggregator hosts, Walrus package ids) and the relay-aware fetch.
export {
  createWalrusClient,
  getWalrusPackageConfig,
  walrusBlobUrl,
  DEFAULT_RPC_URLS,
  PUBLIC_UPLOAD_RELAY_HOSTS,
  WALRUS_AGGREGATOR_HOSTS,
  TESTNET_WALRUS_PACKAGE_CONFIG,
  MAINNET_WALRUS_PACKAGE_CONFIG,
  DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST,
  relayAuthFetch,
} from './client.js'
export type { CreateWalrusClientOptions, WalrusClientNetwork, WalrusNetwork } from './client.js'

// The limits every upload is checked against, exported so a UI can validate its form with the same rules.
export { MAX_SINGLE_RESERVATION_EPOCHS, assertEpochs, assertTipCapMist } from './limits.js'

// Uploading: one-shot byte upload, the step-by-step flow (so a wallet can sign each step), and the image variants.
export {
  LONG_TERM_EPOCHS,
  maxEpochsAhead,
  uploadBytes,
  createUploadFlow,
  uploadImageBytes,
  createBlobUploadFlow,
} from './upload.js'
export type { WalrusClient, UploadOptions, UploadResult } from './upload.js'

// Managing a stored blob: extend its lifetime, certify it, estimate costs, and read or write its attributes.
export {
  extendBlobLifetime,
  extendBlobLifetimeTransaction,
  certifyBlobTransaction,
  estimateStorageCost,
  setBlobAttributes,
  setBlobAttributesTransaction,
  readBlobAttributes,
} from './manage.js'
export type { ExtendOptions, CertifyOptions, StorageCost } from './manage.js'

// Listing the blobs an address owns.
export { fetchOwnedWalrusBlobs } from './query.js'
export type { OwnedBlob } from './query.js'

// Access proofs for a relay that runs behind the access-gate gateway (the protocol itself is in `@meddleware/access-gate-gateway-client`).
export {
  personalMessage,
  buildAccessProofToken,
  fetchRelayChallenge,
  createRelayAccessToken,
} from './access.js'
export type { RelayChallenge, AccessProofInput, PersonalMessageSigner, SuiNetwork } from './access.js'

// Re-exported from the SDK so a consumer does not need a second import for the two names it meets most.
export { WalrusFile, RetryableWalrusClientError } from '@mysten/walrus'
