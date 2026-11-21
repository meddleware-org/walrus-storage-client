/**
 * @file Managing a stored blob: extend its lifetime, certify it, price it, and read or write its on-chain attributes.
 *
 * Role: Walrus blobs expire, so owners must be able to extend them; each action has a Node variant (signs and executes with a keypair) and a browser variant (builds an
 * unsigned transaction for a wallet). A few SDK behaviours are worked around here and each is explained where it happens: the SDK cannot tell "this blob has no attributes"
 * from "there is no such blob", so the Blob object is checked before either is reported.
 *
 * Main exports: `extendBlobLifetime`, `extendBlobLifetimeTransaction`, `certifyBlobTransaction`, `estimateStorageCost`, `setBlobAttributes`, `readBlobAttributes`.
 * Tested in `tests/manage.test.ts`.
 */
import type { Signer } from '@mysten/sui/cryptography'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeStructTag } from '@mysten/sui/utils'
import type { createWalrusClient } from './client.js'

/** A Walrus-extended Sui client, as returned by {@link createWalrusClient}. */
export type WalrusClient = ReturnType<typeof createWalrusClient>

/**
 * True when `err` is a Sui "object / dynamic field not found" error, classified by its `code` only
 * (`'notExists'` for the derived field object, `'dynamicFieldNotFound'` for the parent): `@mysten/sui`'s
 * `ObjectError` is not exported, so we duck-type on it. Message text is never matched. The same code
 * is raised for a wrong parent id, so callers confirm the Blob exists ({@link assertBlobObject}).
 */
function isMissingFieldError(err: unknown): boolean {
  // Duck-typed on `code`: the SDK's error class is not exported, and message text can change between versions.
  const code = (err as { code?: unknown } | null)?.code
  return code === 'notExists' || code === 'dynamicFieldNotFound'
}

/**
 * Throw unless `blobObjectId` is an existing Walrus Blob object (exact normalised type), so "this
 * blob has no attributes yet" is never confused with "there is no such blob".
 */
async function assertBlobObject(client: WalrusClient, blobObjectId: string): Promise<void> {
  // The Blob struct's full type, from the Walrus client.
  const blobType = await client.walrus.getBlobType()
  let type: string
  try {
    type = (await client.core.getObject({ objectId: blobObjectId })).object.type
  } catch (err) {
    // The same error code means "no such object" here; any other failure (a network error) is rethrown untouched.
    if (isMissingFieldError(err)) throw new Error(`walrus-storage-client: no Walrus Blob object ${blobObjectId}`, { cause: err })
    throw err
  }
  // The object exists but is something else (a coin, a look-alike): refuse, comparing normalised types.
  if (normalizeStructTag(type) !== normalizeStructTag(blobType)) {
    throw new Error(`walrus-storage-client: object ${blobObjectId} is not a Walrus Blob`)
  }
}

/**
 * How to extend a blob's storage: either add `epochs` more, or extend up to an
 * absolute `endEpoch`. Exactly one of the two must be provided.
 */
export type ExtendOptions =
  | { epochs: number; endEpoch?: never }
  | { endEpoch: number; epochs?: never }

/**
 * Extend a blob's storage lifetime on-chain (Node.js — signs and executes).
 * Since Walrus blobs expire, call this before expiry to prevent data loss.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id (not the blob id).
 * @param signer The keypair paying for and authorising the extension.
 * @param options Add `epochs` more, or extend to an absolute `endEpoch`.
 * @returns The executed transaction digest.
 */
export async function extendBlobLifetime(
  client: WalrusClient,
  blobObjectId: string,
  signer: Signer,
  options: ExtendOptions,
): Promise<{ digest: string }> {
  // The SDK signs, executes and waits; `options` is exactly one of `epochs` or `endEpoch` (the union type forbids both).
  const result = await client.walrus.executeExtendBlobTransaction({
    blobObjectId,
    signer,
    ...options,
  })
  return { digest: result.digest }
}

/**
 * Build (but do not sign) a blob-lifetime-extension transaction for a browser
 * wallet to sign. Browser counterpart of {@link extendBlobLifetime}.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param options Add `epochs` more, or extend to an absolute `endEpoch`.
 * @returns An unsigned `Transaction`.
 */
export function extendBlobLifetimeTransaction(
  client: WalrusClient,
  blobObjectId: string,
  options: ExtendOptions,
) {
  return client.walrus.extendBlobTransaction({ blobObjectId, ...options })
}

/** A blob's storage-node availability certificate, serialized as base64 (from the upload step). */
export interface CertifyOptions {
  /** The Walrus blob id. */
  blobId: string
  /** The on-chain Blob object id (not the blob id). */
  blobObjectId: string
  /**
   * The base64 availability certificate returned by the upload step. `@mysten/walrus` accepts the
   * base64 string directly (it parses it internally), so no BCS handling is needed here.
   */
  certificate: string
  /** Must match how the blob was registered (our uploads register non-deletable). */
  deletable?: boolean
}

/**
 * Build (but do not sign) a transaction that certifies an already-uploaded blob, for a browser
 * wallet to sign. Lets an upload that was registered + uploaded (and paid for) but not certified —
 * e.g. the user dismissed the certify prompt — be completed later without re-uploading: certify is a
 * plain owner transaction that submits the stored availability certificate, validated on-chain.
 *
 * @param client A Walrus-extended client.
 * @param options The blob ids + the base64 certificate captured at upload time.
 * @returns An unsigned `Transaction`.
 */
export function certifyBlobTransaction(client: WalrusClient, options: CertifyOptions) {
  // `deletable` must match how the blob was registered, or the on-chain call aborts; our uploads register non-deletable, hence the default.
  return client.walrus.certifyBlobTransaction({
    blobId: options.blobId,
    blobObjectId: options.blobObjectId,
    certificate: options.certificate,
    deletable: options.deletable ?? false,
  })
}

/** Breakdown of the on-chain cost (in MIST) of storing a blob of `size` bytes for `epochs` epochs. */
export interface StorageCost {
  /** Per-epoch storage cost × epochs (the part that scales with duration / that an extend pays). */
  storageCost: bigint
  /** One-time write cost (paid on registration, not on extend). */
  writeCost: bigint
  /** `storageCost + writeCost`. */
  totalCost: bigint
}

/**
 * Estimate the on-chain storage cost of a blob, so the UI can price a chosen reservation or extension
 * duration. Thin wrapper over the SDK's `walrus.storageCost(size, epochs)` — kept here so Vue layers
 * (which must not import `@mysten/walrus`) can price durations through the injected client.
 *
 * @param client A Walrus-extended client.
 * @param size Unencoded blob size in bytes.
 * @param epochs Number of epochs to price (reservation length, or epochs added on extend).
 * @returns Storage/write/total cost in MIST.
 */
export function estimateStorageCost(
  client: WalrusClient,
  size: number,
  epochs: number,
): Promise<StorageCost> {
  return client.walrus.storageCost(size, epochs)
}

/**
 * Set on-chain key/value attributes on a blob (Node.js — signs and executes). A
 * `null` value deletes that attribute.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param signer The keypair authorising the write.
 * @param attributes Attributes to set; `null` deletes the key.
 * @returns The executed transaction digest.
 */
export async function setBlobAttributes(
  client: WalrusClient,
  blobObjectId: string,
  signer: Signer,
  attributes: Record<string, string | null>,
): Promise<{ digest: string }> {
  // The common path: the SDK reads the existing attributes, computes a diff, and writes it.
  try {
    const result = await client.walrus.executeWriteBlobAttributesTransaction({
      blobObjectId,
      signer,
      attributes,
    })
    return { digest: result.digest }
  } catch (err) {
    // First write on a blob with no `metadata` dynamic field: the SDK's writeBlobAttributes reads the
    // existing attributes to compute a diff, which throws here (the field doesn't exist yet). Rebuild
    // passing `blobObject` instead of `blobObjectId` — that path skips the read and adds the metadata
    // struct itself (null-valued keys are simply skipped, correct for a fresh blob). The SDK still
    // signs, executes, and waits internally. The same error also means "no such object", so the
    // Blob is confirmed to exist first.
    // Any other error is real. Otherwise confirm the Blob exists (the same code also means "no such object"), then retry the first-write way.
    if (!isMissingFieldError(err)) throw err
    await assertBlobObject(client, blobObjectId)
    const tx = new Transaction()
    const result = await client.walrus.executeWriteBlobAttributesTransaction({
      transaction: tx,
      blobObject: tx.object(blobObjectId),
      signer,
      attributes,
    })
    return { digest: result.digest }
  }
}

/**
 * Build (but do not sign) a set-blob-attributes transaction for a browser wallet
 * to sign. Browser counterpart of {@link setBlobAttributes}.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @param attributes Attributes to set; `null` deletes the key.
 * @returns An unsigned `Transaction`.
 */
export function setBlobAttributesTransaction(
  client: WalrusClient,
  blobObjectId: string,
  attributes: Record<string, string | null>,
) {
  // The SDK reads the current attributes to diff against; a null value deletes a key.
  return client.walrus.writeBlobAttributesTransaction({ blobObjectId, attributes })
}

/**
 * Read a blob's on-chain attributes.
 *
 * @param client A Walrus-extended client.
 * @param blobObjectId The on-chain Blob object id.
 * @returns The attribute map, or `null` if the blob has none.
 */
export async function readBlobAttributes(
  client: WalrusClient,
  blobObjectId: string,
): Promise<Record<string, string> | null> {
  let attributes: Record<string, string> | null
  try {
    attributes = await client.walrus.readBlobAttributes({ blobObjectId })
  } catch (err) {
    // A blob with no attributes has no `metadata` dynamic field; older SDKs throw rather than
    // returning null. Honour this function's documented contract for that case, and only that case.
    if (!isMissingFieldError(err)) throw err
    attributes = null
  }
  // Attributes were read: return them as they are.
  if (attributes !== null) return attributes
  // `null` must mean "this Blob has no attributes", never "no such object" (the SDK cannot tell the two apart).
  await assertBlobObject(client, blobObjectId)
  return null
}
