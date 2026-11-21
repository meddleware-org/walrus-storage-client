/**
 * @file Uploading to Walrus: one-shot Node uploads and the step-by-step flows a browser wallet drives.
 *
 * Role: two kinds of stored object. A quilt (a bundle of files) is the default for documents; a raw blob is served directly at its blob URL, which assets such as token icons
 * need. Each has a Node helper that signs with a keypair and a flow object for a browser, where the wallet signs the register and certify steps. `epochs` is validated against
 * the network's live maximum before any prompt, because the on-chain abort it prevents costs gas and a signature.
 *
 * Main exports: `uploadBytes`, `createUploadFlow`, `uploadImageBytes`, `createBlobUploadFlow`, `maxEpochsAhead`, `LONG_TERM_EPOCHS`. Tested in `tests/upload.test.ts`; the
 * resumable, retained flow with relay access is in `flow.ts`.
 */
import { WalrusFile } from '@mysten/walrus'
import type { Signer } from '@mysten/sui/cryptography'
import type { createWalrusClient } from './client.js'
import { MAX_SINGLE_RESERVATION_EPOCHS, assertEpochs } from './limits.js'

/** The return type of {@link createWalrusClient}. */
export type WalrusClient = ReturnType<typeof createWalrusClient>

// Re-exported so a caller can clamp a requested duration with the same constant.
export { MAX_SINGLE_RESERVATION_EPOCHS }

/**
 * The network's current `max_epochs_ahead`, read from the Walrus system object, or
 * {@link MAX_SINGLE_RESERVATION_EPOCHS} when it cannot be read. Used to validate `epochs` before a
 * wallet prompt is shown.
 */
export async function maxEpochsAhead(client: WalrusClient): Promise<number> {
  // The live value is a u32 in the system object; the SDK's type for it is loose, so it is checked before use.
  try {
    const state = (await client.walrus.systemState()) as { max_epochs_ahead?: unknown }
    const n = Number(state?.max_epochs_ahead)
    return Number.isSafeInteger(n) && n >= 1 ? n : MAX_SINGLE_RESERVATION_EPOCHS
  } catch {
    // A node that cannot answer must not block an upload: fall back to the constant (53 on testnet and mainnet).
    return MAX_SINGLE_RESERVATION_EPOCHS
  }
}

/**
 * Recommended TARGET lifetime for critical assets (~7.7 years at a ~2-week epoch
 * cadence). NOTE: this cannot be reached in one reservation — it exceeds
 * {@link MAX_SINGLE_RESERVATION_EPOCHS}. Reaching it requires periodic renewal via
 * {@link extendBlobLifetime} before expiry. When passing this as an initial
 * `epochs` value, clamp to `MAX_SINGLE_RESERVATION_EPOCHS` first, or pass an
 * explicit `epochs <= 53`.
 */
export const LONG_TERM_EPOCHS = 200

/** Options shared by all upload helpers. */
export type UploadOptions = {
  /** Storage epochs to reserve (default: {@link MAX_SINGLE_RESERVATION_EPOCHS}). */
  epochs?: number
  /** Whether the blob can be deleted by its owner (default false). */
  deletable?: boolean
  /** Arbitrary key-value metadata tags stored with the blob. */
  tags?: Record<string, string>
}

/** The object IDs returned after a successful upload. */
export type UploadResult = {
  /** Walrus content-addressed blob ID. */
  blobId: string
  /** On-chain Walrus blob object ID. */
  blobObjectId: string
}

/** `epochs` validated against the network's live maximum; the maximum itself when omitted. */
async function resolveEpochs(client: WalrusClient, epochs: number | undefined): Promise<number> {
  // The live maximum; an omitted value means "as long as Walrus allows", an explicit one is validated against it.
  const max = await maxEpochsAhead(client)
  return epochs === undefined ? max : assertEpochs(epochs, max)
}

/**
 * Upload raw bytes as a Walrus quilt (file bundle). Use this from Node.js with a keypair
 * signer; use {@link createUploadFlow} in the browser for wallet-popup-safe signing.
 *
 * @throws {Error} if the Walrus write transaction fails or the signer rejects.
 */
export async function uploadBytes(
  client: WalrusClient,
  contents: Uint8Array,
  identifier: string,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  // One file in a quilt, with its identifier and tags.
  const file = WalrusFile.from({ contents, identifier, tags: options.tags })
  const [result] = await client.walrus.writeFiles({
    files: [file],
    // Default to the largest reservation Walrus accepts; a caller wanting the
    // LONG_TERM target must renew via extendBlobLifetime after this.
    epochs: await resolveEpochs(client, options.epochs),
    deletable: options.deletable ?? false,
    signer,
  })
  // One file in, one result out; none means the SDK returned nothing to report.
  if (!result) throw new Error('Walrus returned no write result for the file.')
  return { blobId: result.blobId, blobObjectId: result.id }
}

/**
 * Begin a multi-step quilt upload flow suitable for browser wallet signing.
 * The caller drives the flow: encode → register (wallet signs) → upload → certify (wallet signs).
 */
export function createUploadFlow(
  client: WalrusClient,
  contents: Uint8Array,
  identifier: string,
  options: UploadOptions = {},
) {
  // Only the tags matter here: the epochs and deletable flag are passed to the flow's `register` step by the caller.
  const file = WalrusFile.from({ contents, identifier, tags: options.tags })
  return client.walrus.writeFilesFlow({ files: [file] })
}

// ─── Raw blobs ───────────────────────────────────────────────────────────────
// `createUploadFlow` / `uploadBytes` store a QUILT (a bundle of files); reading
// the quilt blob id back returns the encoded quilt, not the file. For assets that
// must be served directly by their blob URL (e.g. a token icon rendered by
// wallets/explorers), use a RAW blob: `GET /v1/blobs/<blobId>` returns the exact
// bytes. See `walrusBlobUrl()` in ./client.

/**
 * Upload raw bytes as a Walrus raw blob (served directly at `/v1/blobs/<blobId>`).
 * Use this for assets that must be URL-addressable (e.g. token icons). Node.js only.
 *
 * @throws {Error} if the Walrus write transaction fails or the signer rejects.
 */
export async function uploadImageBytes(
  client: WalrusClient,
  contents: Uint8Array,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  // A raw blob (not a quilt): `GET /v1/blobs/<blobId>` returns exactly these bytes.
  const res = await client.walrus.writeBlob({
    blob: contents,
    // Default to the largest reservation Walrus accepts (see uploadBytes).
    epochs: await resolveEpochs(client, options.epochs),
    deletable: options.deletable ?? false,
    signer,
  })
  return { blobId: res.blobId, blobObjectId: res.blobObject.id }
}

/**
 * Begin a multi-step raw-blob upload flow suitable for browser wallet signing.
 *
 * Drive the returned flow:
 * ```ts
 * await flow.encode()
 * const regTx = flow.register({ owner, epochs, deletable }) // wallet signs + executes
 * await flow.upload({ digest })                              // digest of regTx
 * const certTx = flow.certify()                              // wallet signs + executes
 * const { blobId } = await flow.getBlob()                   // use walrusBlobUrl(network, blobId)
 * ```
 */
export function createBlobUploadFlow(client: WalrusClient, contents: Uint8Array) {
  // The SDK's flow object; its steps are listed in the comment above.
  return client.walrus.writeBlobFlow({ blob: contents })
}
