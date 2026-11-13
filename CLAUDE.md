# CLAUDE.md — @meddleware/walrus-storage-client

## Invariants

- **No JavaScript build step: the package ships TypeScript source, plus generated declarations.**
  Entry points (each has a `types` condition pointing at `dist/<name>.d.ts` and a `default` pointing
  at the source):
  - `"."` → `src/index.ts`, browser-safe;
  - `"./flow"` → `src/flow.ts`, the upload orchestrator, lazy about wasm;
  - `"./http"` → `src/http.ts`, publisher and aggregator over plain `fetch`;
  - `"./node"` → `src/node.ts`, Node.js only (filesystem utilities).

  Vite apps resolve the source through their own bundler. The only build output is `dist/*.d.ts`
  (`npm run build`, declarations only, like the sibling SDK packages; `prepublishOnly` runs it). Do
  not emit JavaScript into `dist/`. Node.js-only imports must use `@meddleware/walrus-storage-client/node`, to
  avoid warnings about Node-only modules in browser bundles. `engines.node` is `>=24` (fleet decision).
- **No hardcoded package addresses.** Walrus object type resolution must remain dynamic (see `query.ts`). Never introduce hardcoded Walrus package IDs — they differ between testnet and mainnet.
- **`disableUploadRelay` is a safety valve, not the default.** The relay is required for browser uploads. Direct-to-storage-node only works from Node.js (or when the relay is explicitly unavailable). Default relay fallback must remain `PUBLIC_UPLOAD_RELAY_HOSTS[network]` (Mysten public relay — correct for any operator; operators with their own relay pass `uploadRelayHost` explicitly).
- **`rpcUrl` overrides `DEFAULT_RPC_URLS`, never removes them.** The default URLs must always be present so the client works out-of-the-box without configuration.
- **Access proof format is the wire format.** The challenge/proof helpers in `access.ts` must stay compatible with the access-gate gateway wire protocol (`access-gate-gateway:access:v3`, an audience-bound message: gateway origin, gate, network, nonce, consume digest). Do not change the encoding without coordinating with the gateway.
- **Relay auth is injected via `fetch`, not `headers`.** `@mysten/walrus`'s `UploadRelayClient` options are only `{ host, fetch, timeout, onError }` — there is **no `headers` option** (a `headers` key is silently dropped, so a gated relay never sees the token and returns `401 missing access proof`). `createWalrusClient` therefore threads `uploadRelayAuthToken` by wrapping `globalThis.fetch` and setting `Authorization: Bearer <token>` on every relay request. The token may be a **provider function resolved per request** (not just a static string) so a retained upload flow can be resumed with a fresh challenge signature — the injected `fetch` reads the current token on each call. Do **not** revert to passing `uploadRelay.headers`. Re-verify this wiring whenever `@mysten/walrus` is upgraded — if the SDK later adds a first-class `headers`/auth option, migrate deliberately and update `tests/client.test.ts`.
- **`./flow` never imports the package root statically.** It loads it through `loadWalrusClient`
  (a dynamic import by default), so apps keep `@mysten/walrus` wasm out of their eager bundle. It
  may import `./access.js` and `@meddleware/access-gate-gateway-client` (no wasm). The flow's invariants:
  - register fresh on every attempt, never resumed across loads (the relay rejects an old register tx);
  - persist `{ digest, nftId, savedAt }` before register and validate it before reuse; clear it once
    the upload lands;
  - mint the signed token AFTER register, right before each upload attempt;
  - retry a failed upload on the same registration within `REGISTRATION_FRESH_MS`, bounded by
    `UPLOAD_ATTEMPTS`, with a fresh token each time; re-consume only on `isRedeemedConflict` (a 409 whose body carries `code: 'redeemed'`, read through
    access-gate-gateway-client's `GATEWAY_STATUS` / `parseGatewayError`; message text is never matched) (or a
    rejected resumed consume, once); attach `uploadRetry` when attempts run out;
  - a certify-only failure carries a retry and never repeats the upload;
  - the existing-copy precheck runs before register.
  The flow is access_gate-agnostic: the consume builder is injected.
- **`./http` imports nothing from `@mysten/*`.** It is plain `fetch` against a publisher and
  aggregator, https only (http only for localhost), and stores blobs permanent.
- **`LONG_TERM_EPOCHS` and `MAX_SINGLE_RESERVATION_EPOCHS` are not arbitrary.** They reflect Walrus protocol constraints. Update them only when the Walrus protocol changes `max_epochs_ahead`.
- **Browser storage through `browserStorage()`.** Apps pass it (never `window.localStorage`, whose access can throw) to the flow's storage ports.
- **No secrets in source.** Relay auth tokens, keypairs, and credentials are caller-supplied at runtime. Never hardcode them.
- **0BSD licence.** Do not change the licence.
- **`uploadRelayMaxTipMist` is a library default, not a hardcoded income value.** The `DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST` (5,000,000 MIST = 0.005 SUI since 0.0.29) default in `client.ts` bounds relay tip payments: ~8× the worst-case tip of the operator's linear relay at the 100 MiB edge cap, so a hostile relay is bounded but no legitimate upload fails (the previous 1,000,000 default sat *below* the operator relay's minimum tip). Callers override it via `CreateWalrusClientOptions`. Do not treat it as a commission parameter — the on-chain commission is enforced by the `PlatformConfig` object in `access_gate`.
- **`access.ts` imports from `@meddleware/access-gate-gateway-client`.** The Walrus-specific aliases (`RelayChallenge`, `AccessProofInput`, `buildAccessProofToken`, `fetchRelayChallenge`) are thin re-exports kept for API stability. The unique piece is `createRelayAccessToken` (one-shot: challenge → sign → encode).
- **No ABI-drift test here (workspace B8).** This package builds no Move calls of its own: every
  transaction comes from `@mysten/walrus`, which resolves the Walrus system and staking objects from
  `TESTNET_/MAINNET_WALRUS_PACKAGE_CONFIG` at run time and tracks their upgrades itself. Drift shows
  up as an `@mysten/walrus` release, so keep that dependency current instead. Add a drift test (as in
  access-gate-client) if a direct `tx.moveCall` is ever added.

## Layout, commands and release

```text
src/index.ts    public re-exports of the root entry (`.`)
src/client.ts   createWalrusClient(), host constants (DEFAULT_RPC_URLS, PUBLIC_UPLOAD_RELAY_HOSTS, WALRUS_AGGREGATOR_HOSTS,
                DEFAULT_UPLOAD_RELAY_MAX_TIP_MIST), WalrusNetwork, relayAuthFetch
src/limits.ts   epoch and tip-cap validation (assertEpochs, assertTipCapMist), MAX_SINGLE_RESERVATION_EPOCHS (53, the Walrus
                `max_epochs_ahead` fallback)
src/upload.ts   uploadBytes, createUploadFlow (browser-safe multi-step), uploadImageBytes, createBlobUploadFlow, LONG_TERM_EPOCHS (200)
src/manage.ts   extendBlobLifetime, setBlobAttributes, readBlobAttributes (+ *Transaction variants returning an unsigned Transaction)
src/query.ts    fetchOwnedWalrusBlobs (dynamic type resolution)
src/access.ts   challenge/proof construction for the NFT-gated relay (createRelayAccessToken, buildAccessProofToken, fetchRelayChallenge)
src/flow.ts     `./flow`: runBlobUpload and the resume conventions; conflict handling via access-gate-gateway-client's parseGatewayError
src/http.ts     `./http`: publisher store and aggregator read over fetch; https only, bounded responses, no redirects
src/node.ts     `./node`: Node-only filesystem upload (uploadLocalFile)
tests/          vitest unit tests (mocked client), packaging and release-gate tests; tests/integration is the localnet suite
localnet/       Docker localnet harness (not published)
```

`npm run type-check`, `npm run lint`, `npm test`, `npm run build` (declarations into `dist/`), `npm run test:integration` (localnet suite;
needs `localnet/scripts/up.sh` + `bootstrap-localnet.sh` first). Licence: 0BSD; Node.js >= 24 (`engines`) and browsers (via Vite).

Release (CI on a `v*` tag, npm trusted publishing, `npm-publish.yml`; `prepublishOnly` rebuilds the declarations):

1. Bump `version` in `package.json` and the lockfile root entry (`npm version patch --no-git-tag-version`; patch bumps only until mainnet).
2. Add a `CHANGELOG.md` entry.
3. `npm run type-check`, `npm run lint`, `npm test` and `npm run build` pass.
4. `@mysten/sui` and `@mysten/walrus` versions match the target Sui/Walrus testnet release.
5. The localnet suite is green: the publish workflow's `localnet-gate` blocks a tag while the newest "Integration (localnet)" run on main is
   red or older than 72 h. After a fix, dispatch the workflow on main (or on the commit to tag) and wait for it to pass before pushing the tag.

Consumers to coordinate with on breaking changes: `@meddleware/walrus-storage-kit` (relay UI library; wires `createWalrusClient` /
`createBlobUploadFlow` into the upload widget), `@meddleware/walrus-storage-ui` (standalone uploader app), `token-issuance-ui` (token icon
upload) and the other apps that depend on this package. Its own upstream dependency is `@meddleware/access-gate-gateway-client` (the
access-proof wire format re-exported from `src/access.ts`).

---

## Deferred documentation — NOT for the `docs.` website (planned here per Part 0.4)

> Captured for the future **`meddleware.dev`** subdomain and white-label offering; excluded
> from the user-facing `docs.` site. The user-facing Walrus Storage docs cover *what/how/when* only.

### `dev.` — developer integration (to write later)

- **Full SDK reference** (TypeDoc target — everything is exported from `src/index.ts` with doc
  comments): `createWalrusClient`, the upload flows (`uploadBytes`/`createUploadFlow`/…), lifetime
  management (`extendBlobLifetime`, `estimateStorageCost`, `setBlobAttributes`), `fetchOwnedWalrusBlobs`,
  and the relay access-proof helpers.
- **Integration recipes:** Node vs browser upload; the epoch/lifetime model and
  `LONG_TERM_EPOCHS`/`MAX_SINGLE_RESERVATION_EPOCHS` constraints; resuming a gated upload with a
  per-request `uploadRelayAuthToken` provider function.
- **Schemas:** `UploadResult`, `OwnedBlob`, `StorageCost`, `RelayChallenge`/`AccessProofInput` shapes;
  the `access-gate-gateway:access:v3` proof wire format (source of truth: `@meddleware/access-gate-gateway-client`).

### White-label (to write later)

- Running against an operator's **own upload relay** (`uploadRelayHost`) and RPC (`rpcUrl` overrides,
  never removes, `DEFAULT_RPC_URLS`); the `uploadRelayMaxTipMist` tip ceiling; how relay commission is
  enforced by `PlatformConfig`/`access_gate`, not by this library.
