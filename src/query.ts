/**
 * @file Listing the Walrus blobs an address owns.
 *
 * Role: the read side for "my blobs" screens. It pages through the address's owned objects of the Walrus Blob type (resolved from the Walrus client, so no package
 * address is hard-coded), checks each object's exact type, and returns only blobs whose fields all parse: a malformed object is skipped, never listed with an invented
 * value. Main export: `fetchOwnedWalrusBlobs`. Tested in `tests/query.test.ts`.
 */
// `blobIdFromInt` turns the on-chain u256 into the URL-safe blob id string an aggregator expects.
import { blobIdFromInt } from '@mysten/walrus'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { normalizeStructTag } from '@mysten/sui/utils'
import type { WalrusClient } from './upload.js'

/**
 * Unwrap a Move-struct field bag from a core `json` value. The gRPC/core API returns struct
 * fields flat (`{ blob_id, size, storage: {...} }`); the old JSON-RPC shape nested them under
 * `.fields`. Tolerate both so parsing is robust to the transport and to the SDK's documented
 * caveat that the `json` shape may vary between API implementations.
 */
function structFields(v: unknown): Record<string, unknown> | undefined {
  // Not an object: nothing to unwrap.
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  // The JSON-RPC rendering nested the fields; the flat gRPC one has no `fields` key.
  const nested = o.fields
  return nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : o
}

/** Upper bound on owned-object pages read by {@link fetchOwnedWalrusBlobs} (50 objects per page). */
export const MAX_OWNED_BLOB_PAGES = 100

/**
 * An unsigned integer rendered as a decimal string (or number); `null` otherwise. A `u64` has at most 20
 * digits, a `u256` (the blob id) at most 78: the limit follows the field, or a real id would be dropped.
 */
function uintField(v: unknown, maxDigits = 20): bigint | null {
  // A number only if it is a safe, non-negative integer (anything else has lost precision or is not a count).
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  // A decimal string within the field's digit limit (a sign, a point or a hex prefix is refused).
  if (typeof v === 'string' && v.length <= maxDigits && /^\d+$/.test(v)) return BigInt(v)
  return null
}

/** The largest `u256` (a blob id's integer form). */
const MAX_U256 = (1n << 256n) - 1n

/** `type` normalised, or `null` if it is not a struct tag. */
function normalizedType(type: unknown): string | null {
  if (typeof type !== 'string') return null
  // The SDK throws on a malformed tag; this function's contract is "null, not an exception".
  try {
    return normalizeStructTag(type)
  } catch {
    return null
  }
}

/** A Walrus blob object owned by a Sui address. */
export type OwnedBlob = {
  /** The on-chain Blob object id. */
  objectId: string
  /** Aggregator-URL-compatible blob id string (`GET /v1/blobs/<blobId>`). */
  blobId: string
  /** Size in bytes. */
  size: number
  /** Epoch at which the blob's storage reservation starts. */
  startEpoch: number
  /** Epoch at which the blob's storage expires. */
  endEpoch: number
  /** Whether the blob has been certified. */
  certified: boolean
  /** Whether its owner can delete it before expiry (blobs are registered permanent by default). */
  deletable: boolean
}

/**
 * Return all Walrus blobs owned by `owner`. Resolves the on-chain Blob struct
 * type dynamically via `getBlobType()`, so no package addresses are hardcoded.
 *
 * @param suiClient A Sui client exposing the unified core API (`SuiGrpcClient`).
 * @param walrusClient A Walrus-extended client (see {@link createWalrusClient}).
 * @param owner The address whose owned blobs to enumerate.
 * @returns The owner's blobs; entries that are not exactly the Blob type, or whose fields are missing
 *   or malformed, are skipped (never listed with invented values).
 * @throws {Error} if an RPC call fails, or more than {@link MAX_OWNED_BLOB_PAGES} pages would be needed.
 */
export async function fetchOwnedWalrusBlobs(
  suiClient: ClientWithCoreApi,
  walrusClient: WalrusClient,
  owner: string,
): Promise<OwnedBlob[]> {
  // The Blob struct's full type, from the Walrus client (it knows the deployed package), so nothing here names a package id.
  const blobType = await walrusClient.walrus.getBlobType()
  /** One page of the owned-objects listing. */
  type OwnedPage = Awaited<ReturnType<typeof suiClient.core.listOwnedObjects>>
  // Everything read so far, in page order.
  const objects: OwnedPage['objects'] = []
  // Where the next page starts; unset asks for the first page.
  let cursor: string | null | undefined
  // Page through every owned blob — a single page silently truncates large wallets — but never
  // without bound (a node that always reports another page must not loop forever).
  let done = false
  for (let n = 0; n < MAX_OWNED_BLOB_PAGES && !done; n++) {
    const page: OwnedPage = await suiClient.core.listOwnedObjects({
      owner,
      type: blobType,
      include: { json: true },
      ...(cursor ? { cursor } : {}),
    })
    objects.push(...page.objects)
    // The last page, or no cursor to continue from.
    if (!page.hasNextPage || !page.cursor) done = true
    else cursor = page.cursor
  }
  // Too many pages: fail loudly rather than return a list that looks complete and is not.
  if (!done) throw new Error(`more than ${MAX_OWNED_BLOB_PAGES} pages of Walrus blobs owned by ${owner}`)

  // The expected type, normalised once; an unparsable one would match nothing, so every object is skipped.
  const expected = normalizedType(blobType)
  const blobs: OwnedBlob[] = []
  for (const obj of objects) {
    // The node filtered by type; check it here too (full normalised type, no look-alikes).
    if (expected === null || normalizedType(obj.type) !== expected) continue
    // The Blob's fields, each read strictly: the blob id is a u256 (up to 78 digits), the rest are u64 or u32.
    const fields = structFields(obj.json)
    const blobIdInt = uintField(fields?.blob_id ?? null, 78)
    const size = uintField(fields?.size)
    // The storage reservation is a nested struct holding the epochs.
    const storage = structFields(fields?.storage)
    const startEpoch = uintField(storage?.start_epoch)
    const endEpoch = uintField(storage?.end_epoch)
    const deletable = fields?.deletable
    // One missing or mistyped field skips the whole object: a half-read blob must never be listed.
    if (
      !fields ||
      blobIdInt === null ||
      blobIdInt > MAX_U256 ||
      size === null ||
      startEpoch === null ||
      endEpoch === null ||
      typeof deletable !== 'boolean'
    ) {
      continue
    }
    // An integer that is not a valid blob id (out of range) is skipped.
    let blobId: string
    try {
      blobId = blobIdFromInt(blobIdInt)
    } catch {
      continue // not a valid blob id: skipped, never listed with an invented value
    }
    blobs.push({
      objectId: obj.objectId,
      blobId,
      // Safe as numbers: epochs are u32 and a blob's size is bounded far below 2^53.
      size: Number(size),
      startEpoch: Number(startEpoch),
      endEpoch: Number(endEpoch),
      // `certified_epoch` is an Option: present once the blob is certified.
      certified: fields.certified_epoch !== null && fields.certified_epoch !== undefined,
      deletable,
    })
  }
  return blobs
}

