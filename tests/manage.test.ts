/**
 * Tests for blob management (`src/manage.ts`): each helper passes the right call to the SDK, the first write of attributes on a blob that has none takes the
 * fallback path, and `null` from `readBlobAttributes` always means "this Blob has no attributes", never "there is no such object". The client is a double that records calls.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  extendBlobLifetime,
  extendBlobLifetimeTransaction,
  certifyBlobTransaction,
  estimateStorageCost,
  setBlobAttributes,
  setBlobAttributesTransaction,
  readBlobAttributes,
} from '../src/manage.js'

/** The Walrus Blob type as the SDK reports it. */
const BLOB_TYPE = '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66::blob::Blob'

/** A Walrus-client double: it records the arguments of every SDK call it receives, and returns a digest from `execute*` methods and a transaction object from the builders. */
function fakeClient() {
  // method name → the arguments of each call.
  const calls: Record<string, any[]> = {}
  /** A recording method for `k`. */
  const record = (k: string) => (arg: any) => {
    ;(calls[k] ||= []).push(arg)
    if (k === 'readBlobAttributes') return { color: 'blue' }
    // execute* methods sign and return a digest; the plain *Transaction
    // builders return an unsigned transaction object.
    if (k.startsWith('execute')) return { digest: `DIGEST_${k}` }
    return { __tx: k }
  }
  const client = {
    walrus: {
      executeExtendBlobTransaction: vi.fn(record('executeExtendBlobTransaction')),
      extendBlobTransaction: vi.fn(record('extendBlobTransaction')),
      certifyBlobTransaction: vi.fn(record('certifyBlobTransaction')),
      storageCost: vi.fn(async (_size: number, _epochs: number) => ({
        storageCost: 900n,
        writeCost: 100n,
        totalCost: 1000n,
      })),
      executeWriteBlobAttributesTransaction: vi.fn(record('executeWriteBlobAttributesTransaction')),
      writeBlobAttributesTransaction: vi.fn(record('writeBlobAttributesTransaction')),
      readBlobAttributes: vi.fn(record('readBlobAttributes')),
      getBlobType: vi.fn(async () => BLOB_TYPE),
    },
    // `core.getObject` answers for the Blob existence check; a test overrides it for a wrong object.
    core: { getObject: vi.fn(async (_o: { objectId: string }) => ({ object: { type: BLOB_TYPE } })) },
  }
  return { client: client as any, calls }
}

/** A stand-in signer: the SDK is a double, so it is never asked to sign. */
const signer = { __signer: true } as any

// The Node helpers sign and execute through the SDK, the browser helpers only build; both are checked at the SDK boundary, which is a double.
describe('extendBlobLifetime', () => {
  it('threads ExtendOptions (epochs form) and returns the digest', async () => {
    const { client, calls } = fakeClient()
    const res = await extendBlobLifetime(client, 'OBJ', signer, { epochs: 10 })
    expect(calls.executeExtendBlobTransaction![0]).toMatchObject({
      blobObjectId: 'OBJ',
      signer,
      epochs: 10,
    })
    expect(res).toEqual({ digest: 'DIGEST_executeExtendBlobTransaction' })
  })

  // The two forms of the options are exclusive (the type forbids both); each must reach the SDK unchanged.
  it('threads ExtendOptions (endEpoch form)', async () => {
    const { client, calls } = fakeClient()
    await extendBlobLifetime(client, 'OBJ', signer, { endEpoch: 500 })
    expect(calls.executeExtendBlobTransaction![0]).toMatchObject({ endEpoch: 500 })
  })
})

describe('extendBlobLifetimeTransaction', () => {
  // The browser variant must only BUILD: signing here would bypass the wallet.
  it('returns an unsigned transaction (wallet-safe)', () => {
    const { client } = fakeClient()
    const tx = extendBlobLifetimeTransaction(client, 'OBJ', { epochs: 3 })
    expect(tx).toEqual({ __tx: 'extendBlobTransaction' })
  })
})

describe('certifyBlobTransaction', () => {
  // `deletable` defaults to false, matching how our uploads register; a mismatch would abort on-chain.
  it('passes the base64 certificate + ids through and returns an unsigned tx', () => {
    const { client, calls } = fakeClient()
    const tx = certifyBlobTransaction(client, {
      blobId: 'BLOB',
      blobObjectId: 'OBJ',
      certificate: 'CERT_B64',
    })
    expect(calls.certifyBlobTransaction![0]).toEqual({
      blobId: 'BLOB',
      blobObjectId: 'OBJ',
      certificate: 'CERT_B64',
      deletable: false,
    })
    expect(tx).toEqual({ __tx: 'certifyBlobTransaction' })
  })
})

describe('estimateStorageCost', () => {
  it('passes size + epochs to the SDK and returns its cost breakdown', async () => {
    const { client } = fakeClient()
    const cost = await estimateStorageCost(client, 2048, 10)
    expect(client.walrus.storageCost).toHaveBeenCalledWith(2048, 10)
    expect(cost).toEqual({ storageCost: 900n, writeCost: 100n, totalCost: 1000n })
  })
})

// Attributes live in a dynamic field that does not exist until the first write; the SDK throws for it and these helpers handle that case.
describe('setBlobAttributes / readBlobAttributes', () => {
  it('executes attribute write with signer and returns digest', async () => {
    const { client, calls } = fakeClient()
    const res = await setBlobAttributes(client, 'OBJ', signer, { color: 'blue', old: null })
    expect(calls.executeWriteBlobAttributesTransaction![0]).toMatchObject({
      blobObjectId: 'OBJ',
      signer,
      attributes: { color: 'blue', old: null },
    })
    expect(res).toEqual({ digest: 'DIGEST_executeWriteBlobAttributesTransaction' })
  })

  it('setBlobAttributesTransaction returns an unsigned tx', () => {
    const { client } = fakeClient()
    const tx = setBlobAttributesTransaction(client, 'OBJ', { a: 'b' })
    expect(tx).toEqual({ __tx: 'writeBlobAttributesTransaction' })
  })

  // The common path: the SDK answers, so the map comes back as it is.
  it('readBlobAttributes returns the attribute map', async () => {
    const { client } = fakeClient()
    const attrs = await readBlobAttributes(client, 'OBJ')
    expect(attrs).toEqual({ color: 'blue' })
  })
})

// The same SDK error means "no attributes yet" and "no such blob"; the helpers must tell them apart by checking the Blob object.
describe('missing-attributes handling', () => {
  // The two error codes the SDK uses: a missing dynamic field (no attributes yet) and a missing object (no such blob).
  const missing = Object.assign(new Error('Dynamic field not found'), { code: 'dynamicFieldNotFound' })
  const noObject = Object.assign(new Error('Object 0xOBJ does not exist'), { code: 'notExists' })

  it('readBlobAttributes returns null for a Blob without a metadata field and rethrows other errors', async () => {
    const { client } = fakeClient()
    // Both the throwing form (older SDKs) and the null form (current) must give `null`, and the Blob must be confirmed in each case.
    client.walrus.readBlobAttributes.mockImplementationOnce(() => {
      throw missing
    })
    expect(await readBlobAttributes(client, 'OBJ')).toBeNull()
    // the current SDK returns null itself; the Blob is still confirmed
    client.walrus.readBlobAttributes.mockImplementationOnce(() => null as never)
    expect(await readBlobAttributes(client, 'OBJ')).toBeNull()
    expect(client.core.getObject).toHaveBeenCalledTimes(2)
    client.walrus.readBlobAttributes.mockImplementationOnce(() => {
      throw new Error('rpc down')
    })
    await expect(readBlobAttributes(client, 'OBJ')).rejects.toThrow('rpc down')
  })

  it('readBlobAttributes throws for a wrong object id instead of reporting "no attributes"', async () => {
    const { client } = fakeClient()
    client.walrus.readBlobAttributes.mockImplementationOnce(() => null as never)
    client.core.getObject.mockRejectedValueOnce(noObject)
    await expect(readBlobAttributes(client, '0xOBJ')).rejects.toThrow(/no Walrus Blob object 0xOBJ/)

    client.walrus.readBlobAttributes.mockImplementationOnce(() => {
      throw missing
    })
    client.core.getObject.mockResolvedValueOnce({ object: { type: '0x2::coin::Coin<0x2::sui::SUI>' } })
    await expect(readBlobAttributes(client, '0xCOIN')).rejects.toThrow(/not a Walrus Blob/)
  })

  // Classification is by `code` only: an error whose message merely mentions a missing field must not be swallowed.
  it('does not take an error for a missing field because its message says so', async () => {
    const { client } = fakeClient()
    client.walrus.readBlobAttributes.mockImplementationOnce(() => {
      throw new Error('Dynamic field not found: it does not exist')
    })
    await expect(readBlobAttributes(client, 'OBJ')).rejects.toThrow('does not exist')
    expect(client.core.getObject).not.toHaveBeenCalled()
  })

  it('setBlobAttributes retries the first write with the blob object when the field does not exist yet', async () => {
    const { client } = fakeClient()
    client.walrus.executeWriteBlobAttributesTransaction.mockImplementationOnce(() => {
      throw Object.assign(new Error('x'), { code: 'notExists' })
    })
    const res = await setBlobAttributes(client, 'OBJ', signer, { a: 'b' })
    expect(res.digest).toMatch(/DIGEST/)
    expect(client.walrus.executeWriteBlobAttributesTransaction).toHaveBeenCalledTimes(2)
    expect(client.walrus.executeWriteBlobAttributesTransaction.mock.calls[1]![0]).toHaveProperty('blobObject')
    client.walrus.executeWriteBlobAttributesTransaction.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(setBlobAttributes(client, 'OBJ', signer, { a: 'b' })).rejects.toThrow('boom')
  })

  // The fallback builds a transaction on an object that may not exist; the Blob is confirmed first, so a wrong id fails clearly instead.
  it('setBlobAttributes does not take the fallback path for a wrong object id', async () => {
    const { client } = fakeClient()
    client.walrus.executeWriteBlobAttributesTransaction.mockImplementationOnce(() => {
      throw noObject
    })
    client.core.getObject.mockRejectedValueOnce(noObject)
    await expect(setBlobAttributes(client, '0xOBJ', signer, { a: 'b' })).rejects.toThrow(/no Walrus Blob object/)
    expect(client.walrus.executeWriteBlobAttributesTransaction).toHaveBeenCalledTimes(1)
  })

  it('setBlobAttributes does not take the fallback path because of message text alone', async () => {
    const { client } = fakeClient()
    client.walrus.executeWriteBlobAttributesTransaction.mockImplementationOnce(() => {
      throw new Error('Object does not exist')
    })
    await expect(setBlobAttributes(client, 'OBJ', signer, { a: 'b' })).rejects.toThrow('does not exist')
    expect(client.walrus.executeWriteBlobAttributesTransaction).toHaveBeenCalledTimes(1)
  })
})
