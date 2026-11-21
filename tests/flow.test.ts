// Unit tests for the headless upload orchestrator and its resume conventions. A fake root module is
// injected via `loadWalrusClient`, so no wasm, wallet or network is touched.
//
// Why this is the biggest suite: the flow spends a person's money (storage, a pass use) in steps that cannot be replayed, so most of what it promises is "what happens when a
// step fails": the retries are bounded and stay on the same paid registration, a consume is never spent twice, a certify failure never repeats the upload, and nothing
// is stored in the browser beyond what a resume needs. Time, storage, the wallet and the SDK are all doubles.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { GATEWAY_CONFLICT_CODES, decodeAccessProof } from '@meddleware/access-gate-gateway-client'
import { StorageNodeAPIError } from '@mysten/walrus'
import {
  CONSUME_RESUME_MAX_AGE_MS,
  REGISTRATION_FRESH_MS,
  UPLOAD_ATTEMPTS,
  clearPendingCertify,
  consumeStorageKey,
  createGatedAccess,
  getCertifyRetry,
  getDuplicateExisting,
  getUploadRetry,
  httpStatusOf,
  isConsumeRejected,
  isLeasedConflict,
  isRedeemedConflict,
  isStaleProof,
  gatewayConflictCodeOf,
  loadPendingCertifies,
  browserStorage,
  forgetExpiredConsumes,
  pendingCertifyKey,
  runBlobUpload,
  savePendingCertify,
  type GatedAccess,
  type StorageLike,
  type UploadProgress,
  type WalrusClientModule,
} from '../src/flow.js'

/** The error the SDK's upload-relay client throws for a gateway 409: `status` 409, `error` the JSON body. */
function conflict(code: string): StorageNodeAPIError {
  return StorageNodeAPIError.generate(409, { error: `consume ${code}`, code }, undefined)
}

/** An in-memory `StorageLike` (optionally pre-seeded) that also exposes its map, so a test can see exactly what was written or left behind. */
function fakeStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

/** A fake of the lazily loaded package root: the SDK flow records each step in `steps`, and the register and certify transactions are spies. */
function makeModule() {
  // The order the flow's steps were called in.
  const steps: string[] = []
  const regTx = { setSenderIfNotSet: vi.fn(), build: vi.fn(async () => {}) }
  const certTx = { setSenderIfNotSet: vi.fn(), build: vi.fn(async () => {}) }
  const flow = {
    encode: vi.fn(async () => {
      steps.push('encode')
      return { blobId: 'BLOB123' }
    }),
    register: vi.fn(() => {
      steps.push('register')
      return regTx
    }),
    upload: vi.fn(async (_: { digest: string; deletable?: boolean }) => {
      steps.push('upload')
      return { blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64' }
    }),
    certify: vi.fn(() => {
      steps.push('certify')
      return certTx
    }),
    getBlob: vi.fn(async () => ({ blobId: 'BLOB123' })),
  }
  const mod = {
    createWalrusClient: vi.fn((_opts: unknown) => ({ __client: true })),
    createBlobUploadFlow: vi.fn(() => flow),
    walrusBlobUrl: (network: string, blobId: string) => `https://agg.example/${network}/${blobId}`,
  } satisfies WalrusClientModule
  return { mod, flow, regTx, certTx, steps }
}

/** A wallet double: every transaction "executes" with a distinct digest, so a test can tell which one an upload was bound to. */
function makeExecutor() {
  return {
    signAndExecute: vi.fn(async (_tx: unknown) => ({ digest: `dig-${Math.random().toString(16).slice(2)}` })),
    waitForTransaction: vi.fn(async () => {}),
  }
}

// A gate id and two valid-looking transaction digests (the second differs from the first, to tell "the stored one" from "a new one"); a sleep that returns at once.
const GATE = '0x' + 'a1'.repeat(32)
const DIGEST = '5Wq9tE4gXz8hEvFhYt8KkTJb2Pp6qXqj8cRk3xN1mYdL'
const DIGEST2 = '3ucNSQzgjYgSNxS9cM3ZHSc3zLyLEWd9mT4pYiiyqKQ4'
const noSleep = async () => {}

/** The dependencies every `runBlobUpload` test shares; each test adds an executor and the module double. */
const baseDeps = {
  sleep: noSleep,
  bytes: new Uint8Array([1, 2, 3]),
  network: 'testnet' as const,
  relayHost: 'https://relay.example',
  address: '0xabc',
  wasmUrl: 'wasm://bundle',
  maxTipMist: 5_000_000,
  epochs: 53,
  suiClient: { __sui: true } as never,
  onStatus: () => {},
}

/** The error a promise rejects with (fails the test if it resolves), so assertions can inspect the thrown object. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('runBlobUpload', () => {
  it('runs encode → register → upload → certify and resolves id + url + digest', async () => {
    const { mod, steps } = makeModule()
    const executor = makeExecutor()
    const progress: UploadProgress[] = []
    const res = await runBlobUpload({ ...baseDeps, executor, onStatus: (p) => progress.push(p), loadWalrusClient: async () => mod })
    expect(steps).toEqual(['encode', 'register', 'upload', 'certify'])
    expect(res).toEqual({ blobId: 'BLOB123', url: 'https://agg.example/testnet/BLOB123', digest: expect.stringMatching(/^dig-/) })
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // register + certify
    expect(executor.waitForTransaction).toHaveBeenCalledTimes(2)
    expect(progress.map((p) => p.step)).toEqual(['encode', 'register', 'upload', 'certify'])
    expect(progress.every((p) => typeof p.detail === 'string' && p.detail.length > 0)).toBe(true)
  })

  // Permanent is the default because pointers and manifests rely on the blob staying readable; deletable must be an explicit choice.
  it('registers permanent by default and deletable when chosen', async () => {
    for (const [deletable, expected] of [[undefined, false], [true, true]] as const) {
      const { mod, flow } = makeModule()
      await runBlobUpload({ ...baseDeps, ...(deletable === undefined ? {} : { deletable }), executor: makeExecutor(), loadWalrusClient: async () => mod })
      expect(flow.register).toHaveBeenCalledWith(expect.objectContaining({ deletable: expected }))
      expect(flow.upload).toHaveBeenCalledWith(expect.objectContaining({ deletable: expected }))
    }
  })

  // The duration the person chose is what is registered, not a default.
  it('passes the chosen epochs to register', async () => {
    const { mod, flow } = makeModule()
    await runBlobUpload({ ...baseDeps, epochs: 20, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledWith({ owner: '0xabc', epochs: 20, deletable: false })
  })

  // A register transaction embeds a per-encode nonce and the relay's tip, so a stale one is rejected as "too old": it is never resumed across attempts.
  it('always registers fresh and uploads with this attempt\'s register digest', async () => {
    const { mod, flow } = makeModule()
    const executor = makeExecutor()
    await runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledTimes(1)
    const regDigest = (await executor.signAndExecute.mock.results[0]!.value).digest
    expect(flow.upload).toHaveBeenCalledWith({ digest: regDigest, deletable: false })
  })

  // Paying to store the same bytes twice is the avoidable cost; the precheck turns it into an offer to extend or certify the copy the person already owns.
  it('aborts before registering when an existing certified copy is found (offers Extend)', async () => {
    const { mod, flow } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'certified' as const, blobId: 'BLOB123', objectId: 'OBJ_EXISTING', endEpoch: 570 }))
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy }))
    expect(findExistingCopy).toHaveBeenCalledWith('BLOB123')
    expect(getDuplicateExisting(thrown)).toMatchObject({ kind: 'certified', objectId: 'OBJ_EXISTING' })
    expect(flow.register).not.toHaveBeenCalled()
  })

  // An upload that was registered and sent but never certified is not lost: the person is offered "certify" for the copy they already paid for.
  it('surfaces a pending existing copy (offers Certify)', async () => {
    const { mod } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'pending' as const, blobId: 'BLOB123', objectId: 'OBJ_PENDING', endEpoch: 560 }))
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy }))
    expect(getDuplicateExisting(thrown)?.kind).toBe('pending')
  })

  // The person may deliberately want another copy; the precheck must not stop them.
  it('force bypasses the existing-copy check', async () => {
    const { mod, flow } = makeModule()
    const findExistingCopy = vi.fn(async () => ({ kind: 'certified' as const, blobId: 'BLOB123', objectId: 'OBJ', endEpoch: 570 }))
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, findExistingCopy, force: true })
    expect(findExistingCopy).not.toHaveBeenCalled()
    expect(flow.register).toHaveBeenCalledTimes(1)
  })

  // The certificate is kept between upload and certify so a closed tab can finish a paid upload, and removed when it is no longer needed.
  it('persists the certificate on upload and clears it on certify', async () => {
    const { mod } = makeModule()
    const onUploaded = vi.fn()
    const onCertified = vi.fn()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod, onUploaded, onCertified })
    expect(onUploaded).toHaveBeenCalledWith({ blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64', deletable: false })
    expect(onCertified).toHaveBeenCalledWith('OBJ123')
  })

  // Register and upload are paid and cannot be replayed; only certify may be retried, from the certificate the live flow still holds.
  it('on a certify failure, throws with a retry that certifies without re-uploading', async () => {
    const { mod, flow } = makeModule()
    let calls = 0
    const executor = {
      signAndExecute: vi.fn(async () => {
        calls += 1
        if (calls === 2) throw new Error('user rejected certify')
        return { digest: `dig-${calls}` }
      }),
      waitForTransaction: vi.fn(async () => {}),
    }
    const thrown = await rejection(runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod }))
    const retry = getCertifyRetry<{ blobId: string }>(thrown)
    expect(retry).toBeTypeOf('function')
    expect((await retry!()).blobId).toBe('BLOB123')
    expect(flow.certify).toHaveBeenCalledTimes(2)
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(flow.upload).toHaveBeenCalledTimes(1)
  })

  // The SDK builds the transactions without a sender; the wallet needs one to sign, so the flow sets it on both.
  it('sets the sender on both the register and certify transactions', async () => {
    const { mod, regTx, certTx } = makeModule()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(regTx.setSenderIfNotSet).toHaveBeenCalledWith('0xabc')
    expect(certTx.setSenderIfNotSet).toHaveBeenCalledWith('0xabc')
  })

  // The flow only passes through what the app configured; an unset RPC endpoint must not appear as an empty string.
  it('forwards an RPC endpoint when given', async () => {
    const { mod } = makeModule()
    await runBlobUpload({ ...baseDeps, rpcUrl: 'https://rpc.example', executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(mod.createWalrusClient.mock.calls[0]![0]).toMatchObject({ rpcUrl: 'https://rpc.example' })
  })

  // An open relay needs no token; sending an empty provider would add a header nobody asked for.
  it('forwards relay host, tip cap and wasm url, and no auth for an open relay', async () => {
    const { mod } = makeModule()
    await runBlobUpload({ ...baseDeps, executor: makeExecutor(), loadWalrusClient: async () => mod })
    const opts = mod.createWalrusClient.mock.calls[0]![0] as Record<string, unknown>
    expect(opts).toMatchObject({ network: 'testnet', wasmUrl: 'wasm://bundle', uploadRelayHost: 'https://relay.example', uploadRelayMaxTipMist: 5_000_000 })
    expect(opts.uploadRelayAuthToken).toBeUndefined()
  })
})

// With a gated relay the order matters: the consume is spent and stored BEFORE register, the signed token is minted AFTER it (a challenge lives minutes), and every retry
// stays on the same paid registration while it is fresh.
describe('runBlobUpload with gated access', () => {
  /** A `GatedAccess` double that hands out the given tokens in order and records its calls. */
  function access(tokens: string[]) {
    let i = 0
    return {
      prepare: vi.fn(async () => {}),
      token: vi.fn(async (_opts?: { forceFresh?: boolean }) => tokens[i++] ?? `tok-${i}`),
      resumed: vi.fn(() => false),
      uploaded: vi.fn(() => {}),
    } satisfies GatedAccess
  }
  /** The token provider the flow gave the (fake) client, which the relay would call per request. */
  const providerOf = (mod: ReturnType<typeof makeModule>['mod']) =>
    (mod.createWalrusClient.mock.calls[0]![0] as { uploadRelayAuthToken: () => string }).uploadRelayAuthToken

  // Order matters: the consume is persisted first (resumable), the token is minted after register (a challenge outlives neither a slow approval nor a retry).
  it('spends the consume before register, mints the token AFTER register, and threads it into the relay', async () => {
    const { mod, steps } = makeModule()
    const gate = access(['tok-1'])
    gate.prepare.mockImplementation(async () => void steps.push('prepare'))
    gate.token.mockImplementation(async () => {
      steps.push('token')
      return 'tok-1'
    })
    const progress: UploadProgress[] = []
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), onStatus: (p) => progress.push(p), loadWalrusClient: async () => mod })
    expect(steps).toEqual(['prepare', 'encode', 'register', 'token', 'upload', 'certify'])
    expect(providerOf(mod)()).toBe('tok-1')
    expect(progress[0]!.step).toBe('access')
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
  })

  // A 409 `redeemed` means the stored consume already paid for an earlier upload; only then is a new use spent, and the paid registration is reused.
  it('after a redeemed conflict, spends a new use and retries on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(conflict('redeemed'))
    const gate = access(['tok-1', 'tok-2'])
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(gate.token.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: true }]])
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(flow.upload).toHaveBeenCalledTimes(2)
    expect(flow.upload.mock.calls[1]![0].digest).toBe(flow.upload.mock.calls[0]![0].digest)
    expect(providerOf(mod)()).toBe('tok-2')
  })

  // A transient failure must cost nothing extra: no second registration and no second pass use, only a fresh signed token.
  it('a relay 5xx or a network error retries on the same registration with a fresh token, no new consume', async () => {
    for (const failure of [Object.assign(new Error('relay 503'), { status: 503 }), new Error('network down')]) {
      const { mod, flow } = makeModule()
      flow.upload.mockRejectedValueOnce(failure)
      const gate = access(['tok-1', 'tok-2'])
      const executor = makeExecutor()
      await runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod })
      expect(gate.token.mock.calls).toEqual([[{ forceFresh: false }], [{ forceFresh: false }]])
      expect(flow.register).toHaveBeenCalledTimes(1)
      expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // one register + one certify: not paid twice
    }
  })

  // A challenge lives minutes; a slow approval can outlive it, which the gateway reports as a stale proof. The answer is a fresh signature, not a new registration.
  it('an expired-challenge rejection retries on the same registration with a fresh token', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 403: challenge nonce invalid, expired, or already used'), { status: 403 }))
    const gate = access(['tok-1', 'tok-2'])
    await runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(gate.token).toHaveBeenCalledTimes(2)
  })

  // A stored consume the gateway no longer accepts is dropped and replaced once; a second rejection must not loop and spend a use each time.
  it('a rejected RESUMED consume is dropped and consumed anew, once', async () => {
    const { mod, flow } = makeModule()
    const rejected = Object.assign(new Error('relay 403: no matching single-use consume for this address'), { status: 403 })
    flow.upload.mockRejectedValueOnce(rejected).mockRejectedValueOnce(rejected)
    const gate = access(['tok-1', 'tok-2', 'tok-3'])
    gate.resumed.mockReturnValue(true)
    await expect(runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })).rejects.toThrow(/single-use consume/)
    // First retry re-consumes; a second rejection is final (bounded).
    expect(gate.token.mock.calls[1]).toEqual([{ forceFresh: true }])
    expect(gate.token).toHaveBeenCalledTimes(2)
  })

  // A 4xx that is not about the proof will not change on a retry, so retrying would only delay the person's answer.
  it('does not retry a rejection that is not about the proof (e.g. 400, 403 not an owner)', async () => {
    for (const failure of [Object.assign(new Error('relay 400 bad request'), { status: 400 }), Object.assign(new Error('relay 403 address does not hold the required access NFT'), { status: 403 })]) {
      const { mod, flow } = makeModule()
      flow.upload.mockRejectedValue(failure)
      const gate = access(['tok-1'])
      await expect(runBlobUpload({ ...baseDeps, access: gate, executor: makeExecutor(), loadWalrusClient: async () => mod })).rejects.toThrow()
      expect(flow.upload).toHaveBeenCalledTimes(1)
      expect(gate.uploaded).not.toHaveBeenCalled()
    }
  })

  // After the attempts run out the person is not left with a paid registration and no way forward: the error carries a retry on the same registration.
  it('bounds the retries and hands the caller an uploadRetry on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValue(Object.assign(new Error('relay 502'), { status: 502 }))
    const gate = access([])
    const executor = makeExecutor()
    const err = await rejection(runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod }))
    expect(flow.upload).toHaveBeenCalledTimes(UPLOAD_ATTEMPTS)
    expect(flow.register).toHaveBeenCalledTimes(1)
    const retry = getUploadRetry<{ digest?: string }>(err)
    expect(retry).toBeTypeOf('function')
    // The relay recovers: the retry uploads on the SAME registration, then certifies.
    flow.upload.mockResolvedValue({ blobId: 'BLOB123', blobObjectId: 'OBJ123', certificate: 'CERT_B64' })
    const res = await retry!()
    expect(res).toMatchObject({ blobId: 'BLOB123' })
    expect(flow.register).toHaveBeenCalledTimes(1)
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2) // register once, certify once
  })

  // The relay rejects a stale registration as "too old"; retrying it would only waste time, so the flow gives up and says so.
  it('does not retry once the registration is too old for the relay', async () => {
    const { mod, flow } = makeModule()
    let clock = 1_000_000
    flow.upload.mockImplementation(async () => {
      clock += REGISTRATION_FRESH_MS + 1
      throw Object.assign(new Error('relay 502'), { status: 502 })
    })
    const err = await rejection(runBlobUpload({ ...baseDeps, access: access([]), executor: makeExecutor(), now: () => clock, loadWalrusClient: async () => mod }))
    expect(flow.upload).toHaveBeenCalledTimes(1)
    expect(getUploadRetry(err)).toBeNull()
  })

  // The retry logic is not specific to gated relays: a transient failure on an open relay also keeps the paid registration.
  it('an open relay also retries transient failures on the same registration', async () => {
    const { mod, flow } = makeModule()
    flow.upload.mockRejectedValueOnce(Object.assign(new Error('relay 503'), { status: 503 }))
    const executor = makeExecutor()
    await runBlobUpload({ ...baseDeps, executor, loadWalrusClient: async () => mod })
    expect(flow.upload).toHaveBeenCalledTimes(2)
    expect(executor.signAndExecute).toHaveBeenCalledTimes(2)
  })

  // An out-of-range duration aborts on-chain after the person has approved and paid gas; the check must come first.
  it('rejects invalid epochs before any wallet prompt', async () => {
    const { mod } = makeModule()
    const executor = makeExecutor()
    for (const epochs of [0, -1, 1.5, 54, Number.NaN]) {
      await expect(runBlobUpload({ ...baseDeps, epochs, executor, loadWalrusClient: async () => mod })).rejects.toThrow(/epochs must be/)
    }
    expect(executor.signAndExecute).not.toHaveBeenCalled()
  })

  // Once the relay has the bytes the consume is redeemed; a later certify failure must not leave a stored digest that would be offered again.
  it('marks access spent once the upload lands, even if certify then fails', async () => {
    const { mod } = makeModule()
    let calls = 0
    const executor = {
      signAndExecute: vi.fn(async () => {
        calls += 1
        if (calls === 2) throw new Error('rejected')
        return { digest: `d${calls}` }
      }),
      waitForTransaction: vi.fn(async () => {}),
    }
    const gate = access(['tok'])
    const err = await rejection(runBlobUpload({ ...baseDeps, access: gate, executor, loadWalrusClient: async () => mod }))
    expect(gate.uploaded).toHaveBeenCalledTimes(1)
    expect(getCertifyRetry(err)).toBeTypeOf('function')
    expect(getUploadRetry(err)).toBeNull()
  })
})

// The real access object against doubles: a consume bound to the challenge nonce is persisted before signing, a stored digest is reused only when well-formed, for this
// pass and recent, and an unlimited pass never consumes.
describe('createGatedAccess', () => {
  // A fixed "now", so ages are exact.
  const NOW = 1_800_000_000_000
  /** The ports of a gated access: a spy for every wallet and chain call, a fixed challenge and the fixed clock. */
  function ports(storage: StorageLike, singleUse = true) {
    return {
      storage,
      key: 'k',
      relayHost: 'https://relay.example',
      address: '0xabc',
      gateId: GATE,
      network: 'testnet' as const,
      nftId: '0xnft',
      singleUse,
      buildConsume: vi.fn((_id: string, nonce: string) => ({ nonce })),
      signAndExecute: vi.fn(async (_tx: { nonce: string }) => ({ digest: DIGEST })),
      waitForTransaction: vi.fn(async () => {}),
      sign: vi.fn(async (_m: Uint8Array) => ({ signature: 'U0lH' })),
      fetchChallenge: vi.fn(async () => ({ nonce: 'nonce-xyz', expiresAt: Date.now() + 60_000 })),
      now: () => NOW,
    }
  }
  /** A stored consume record (valid unless `over` breaks a field). */
  const stored = (over: Record<string, unknown> = {}) => JSON.stringify({ digest: DIGEST2, nftId: '0xnft', savedAt: NOW - 1000, ...over })

  it('consumes a use bound to the challenge nonce and persists {digest, nftId, savedAt} before signing', async () => {
    const storage = fakeStorage()
    const p = ports(storage)
    const gate = createGatedAccess(p)
    await gate.prepare()
    expect(p.buildConsume).toHaveBeenCalledWith('0xnft', 'nonce-xyz')
    expect(JSON.parse(storage.getItem('k')!)).toEqual({ digest: DIGEST, nftId: '0xnft', savedAt: NOW })
    expect(p.sign).not.toHaveBeenCalled() // preparing never signs
    const token = await gate.token()
    expect(p.signAndExecute).toHaveBeenCalledTimes(1) // token() reuses the prepared consume
    expect(decodeAccessProof(token)).toMatchObject({ address: '0xabc', nonce: 'nonce-xyz', signature: 'U0lH', consumeDigest: DIGEST })
  })

  it('passes the gateway challenge expiry through, and never prompts the wallet on an expired challenge', async () => {
    // Regression: the flow once built the proof with a synthetic expiresAt of 0, which access-gate-gateway-client 0.0.18 refuses.
    const fresh = ports(fakeStorage(), false)
    await expect(createGatedAccess(fresh).token()).resolves.toEqual(expect.any(String))
    const expired = ports(fakeStorage(), false)
    expired.fetchChallenge = vi.fn(async () => ({ nonce: 'old', expiresAt: Date.now() - 120_000 }))
    await expect(createGatedAccess(expired).token()).rejects.toThrow(/expired/)
    expect(expired.sign).not.toHaveBeenCalled()
  })

  it('signs the audience-bound message: relay origin, gate, network, nonce and the consume', async () => {
    const p = ports(fakeStorage())
    await createGatedAccess(p).token()
    expect(new TextDecoder().decode(p.sign.mock.calls[0]![0])).toBe(
      `access-gate-gateway:access:v3\norigin:https://relay.example\ngate:${GATE}\nnetwork:testnet\nnonce:nonce-xyz\nconsume:${DIGEST}`,
    )
  })

  // The point of persisting the digest: an interrupted upload resumes with a fresh signature but no second use.
  it('reuses a valid stored digest without consuming another use', async () => {
    const p = ports(fakeStorage({ k: stored() }))
    const gate = createGatedAccess(p)
    const token = await gate.token()
    expect(p.signAndExecute).not.toHaveBeenCalled()
    expect(gate.resumed()).toBe(true)
    expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST2)
  })

  // Browser storage is untrusted: a value that is not exactly a recent consume of THIS pass is never presented to the gateway.
  it('drops a stored value that is malformed, for another pass, stale, or from the future, and consumes anew', async () => {
    for (const bad of [
      'plain-old-digest-string',
      '{"digest":"not base58!","nftId":"0xnft","savedAt":1}',
      stored({ nftId: '0xother' }),
      stored({ savedAt: NOW - CONSUME_RESUME_MAX_AGE_MS - 1 }),
      stored({ savedAt: NOW + 3_600_000 }),
      stored({ digest: 7 }),
      '[]',
      'x'.repeat(5000),
    ]) {
      const p = ports(fakeStorage({ k: bad }))
      const gate = createGatedAccess(p)
      const token = await gate.token()
      expect(p.signAndExecute, bad.slice(0, 40)).toHaveBeenCalledTimes(1)
      expect(gate.resumed()).toBe(false)
      expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST)
    }
  })

  it('forceFresh drops a stored digest and consumes anew', async () => {
    const p = ports(fakeStorage({ k: stored() }))
    const token = await createGatedAccess(p).token({ forceFresh: true })
    expect(p.signAndExecute).toHaveBeenCalledTimes(1)
    expect(decodeAccessProof(token).consumeDigest).toBe(DIGEST)
  })

  // Storing a bad digest would make every resume fail; the access step refuses it and stores nothing.
  it('refuses a consume result without a valid digest instead of storing it', async () => {
    const storage = fakeStorage()
    const p = ports(storage)
    for (const digest of [undefined, '', 'DIGEST-1']) {
      p.signAndExecute.mockResolvedValueOnce({ digest } as never)
      await expect(createGatedAccess(p).prepare()).rejects.toThrow(/no valid digest/)
      expect(storage.getItem('k')).toBeNull()
    }
  })

  // An unlimited pass has no uses to spend: only a signature is needed, and nothing is stored.
  it('an unlimited pass only signs', async () => {
    const p = ports(fakeStorage(), false)
    const gate = createGatedAccess(p)
    await gate.prepare()
    const token = await gate.token()
    expect(p.buildConsume).not.toHaveBeenCalled()
    expect(decodeAccessProof(token).consumeDigest).toBeUndefined()
  })

  it('uploaded() clears the stored digest', () => {
    const storage = fakeStorage({ k: stored() })
    createGatedAccess(ports(storage)).uploaded()
    expect(storage.getItem('k')).toBeNull()
  })

  // The gateway re-reads the consume with its own retry; a slow node here must not abort an upload that would have worked.
  it('does not block on an indexing delay after the consume', async () => {
    const p = ports(fakeStorage())
    p.waitForTransaction.mockRejectedValueOnce(new Error('not indexed yet'))
    await expect(createGatedAccess(p).token()).resolves.toBeTypeOf('string')
  })
})

// The flow reacts to errors by what they say structurally (a status, a code in the gateway's JSON), not by message text, except where the SDK gives nothing else.
describe('upload error classification', () => {
  // The SDK reports a status in different places depending on the failure (a field, the message text, a wrapped cause), so all three are read.
  it('reads an HTTP status from the error, its message or its cause', () => {
    expect(httpStatusOf({ status: 503 })).toBe(503)
    expect(httpStatusOf(new Error('relay responded 429 slow down'))).toBe(429)
    expect(httpStatusOf(new Error('outer', { cause: { status: 401 } }))).toBe(401)
    expect(httpStatusOf(new Error('network down'))).toBeNull()
    expect(httpStatusOf(null)).toBeNull()
  })

  // Each helper pairs a status with wording from the gateway's contract, so an unrelated 403 is not mistaken for a stale proof or a rejected consume.
  it('names the gateway rejections the flow reacts to', () => {
    expect(isConsumeRejected(Object.assign(new Error('403 no matching single-use consume for this address'), { status: 403 }))).toBe(true)
    expect(isConsumeRejected(new Error('403 address does not hold the required access NFT'))).toBe(false)
    expect(isLeasedConflict(conflict('leased'))).toBe(true)
    expect(isLeasedConflict(new Error('409 an upload for this consume is already in progress'))).toBe(false)
    expect(isLeasedConflict(conflict('redeemed'))).toBe(false)
    expect(isStaleProof(new Error('401 missing access proof'))).toBe(true)
    expect(isStaleProof(new Error('403 challenge nonce invalid, expired, or already used'))).toBe(true)
    expect(isStaleProof(new Error('403 the gate is paused'))).toBe(false)
  })
})

describe('isRedeemedConflict', () => {
  it('matches the real SDK 409 error carrying the gateway body', () => {
    const err = conflict('redeemed')
    expect(err.status).toBe(409)
    expect(isRedeemedConflict(err)).toBe(true)
    expect(isRedeemedConflict(conflict('leased'))).toBe(false)
    expect(gatewayConflictCodeOf(conflict('leased'))).toBe('leased')
  })

  // The conflict codes come from the protocol package; if it gains one, this client must be reviewed before it acts on it.
  it('knows exactly the codes access-gate-gateway-client exports', () => {
    for (const code of GATEWAY_CONFLICT_CODES) expect(gatewayConflictCodeOf(conflict(code))).toBe(code)
    expect(gatewayConflictCodeOf(StorageNodeAPIError.generate(409, { error: 'x', code: 'invented' }, undefined))).toBeNull()
  })

  it('needs the 409 status and a well-formed gateway body', () => {
    expect(isRedeemedConflict({ status: 500, error: { error: 'x', code: 'redeemed' } })).toBe(false)
    expect(isRedeemedConflict({ status: 409, error: { code: 'redeemed' } })).toBe(false)
    expect(isRedeemedConflict({ status: 409, error: 'redeemed' })).toBe(false)
  })

  it('finds the code in a wrapped cause, and never reads message text', () => {
    expect(isRedeemedConflict(new Error('outer', { cause: conflict('redeemed') }))).toBe(true)
    expect(isRedeemedConflict(new Error('Upload relay responded 409: consume already redeemed'))).toBe(false)
    expect(isRedeemedConflict(new Error('409 conflict'))).toBe(false)
    expect(isRedeemedConflict(Object.assign(new Error('409 redeemed'), { status: 409 }))).toBe(false)
  })

  it('is false for other values', () => {
    expect(isRedeemedConflict(new Error('network'))).toBe(false)
    expect(isRedeemedConflict(null)).toBe(false)
    const loop: { cause?: unknown } = {}
    loop.cause = { cause: loop }
    expect(isRedeemedConflict(loop)).toBe(false)
  })
})

// Browser storage is untrusted: entries are size-capped, copied field by field, and dropped if they do not match their key. Only what a resume needs is kept (STORAGE_LEDGER B5, B6).
describe('persistence keys and pending certifications', () => {
  it('keys are namespaced', () => {
    expect(consumeStorageKey('testnet', '0xgate', '0xaddr')).toBe('mw:walrus:consume:testnet:0xgate:0xaddr')
    expect(pendingCertifyKey('testnet', '0xabc')).toBe('mw:walrus:pendingCertify:testnet:0xabc')
  })

  const entry = { blobId: 'BLOB1', blobObjectId: 'OBJ1', certificate: 'CERT_B64', deletable: false }

  // The round trip of what a closed tab needs to finish a paid upload: save when uploaded, load after a reload, clear when certified.
  it('saves, loads and clears a pending certification', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    savePendingCertify(storage, key, entry)
    const map = loadPendingCertifies(storage, key)
    expect(map.OBJ1).toMatchObject(entry)
    expect(typeof map.OBJ1!.savedAt).toBe('number')
    clearPendingCertify(storage, key, 'OBJ1')
    expect(storage.getItem(key)).toBeNull()
  })

  // Several uploads can be pending at once; finishing one must not forget the others.
  it('keeps other entries when clearing one', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    savePendingCertify(storage, key, entry)
    savePendingCertify(storage, key, { ...entry, blobId: 'BLOB2', blobObjectId: 'OBJ2' })
    clearPendingCertify(storage, key, 'OBJ1')
    expect(Object.keys(loadPendingCertifies(storage, key))).toEqual(['OBJ2'])
  })

  it('drops malformed or mis-keyed stored entries (browser storage is untrusted)', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    const good = { ...entry, savedAt: 1 }
    storage.setItem(
      key,
      JSON.stringify({
        OBJ1: good,
        OBJ2: { ...good, blobObjectId: 'OTHER' }, // key and object id disagree
        OBJ3: { ...good, blobObjectId: 'OBJ3', deletable: 'no' },
        OBJ4: { ...good, blobObjectId: 'OBJ4', extra: '<script>' },
      }),
    )
    const map = loadPendingCertifies(storage, key)
    expect(Object.keys(map).sort()).toEqual(['OBJ1', 'OBJ4'])
    expect(map.OBJ4).toEqual({ ...good, blobObjectId: 'OBJ4' }) // copied field by field
  })

  it('returns an empty map for missing or corrupt data', () => {
    const storage = fakeStorage()
    const key = pendingCertifyKey('testnet', '0xabc')
    expect(loadPendingCertifies(storage, key)).toEqual({})
    storage.setItem(key, 'not json')
    expect(loadPendingCertifies(storage, key)).toEqual({})
    storage.setItem(key, '[1]')
    expect(loadPendingCertifies(storage, key)).toEqual({})
  })
})

// Storage can be missing or throw (blocked site data, some private modes): the flow then keeps values in memory and nothing breaks, it just cannot resume after a reload.
describe('browserStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps values in memory when localStorage is unavailable (blocked site data)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError')
      },
    })
    const storage = browserStorage()
    expect(storage.getItem('k')).toBeNull()
    storage.setItem('k', 'v')
    expect(storage.getItem('k')).toBe('v')
    storage.removeItem('k')
    expect(storage.getItem('k')).toBeNull()
  })

  it('uses localStorage when it works', () => {
    const map = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
    })
    const storage = browserStorage()
    storage.setItem('k', 'v')
    expect(map.get('k')).toBe('v')
    expect(browserStorage().getItem('k')).toBe('v') // survives a new instance (a reload)
  })
})

describe('forgetExpiredConsumes (STORAGE_LEDGER B5)', () => {
  /** A storage double that can be enumerated (the sweep needs `length` and `key`). */
  const enumerable = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries))
    return {
      map,
      get length() {
        return map.size
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    }
  }

  it('removes consumes that can no longer resume and leaves everything else', () => {
    const now = 1_800_000_000_000
    const fresh = JSON.stringify({ digest: 'd', nftId: 'n', savedAt: now - 1000 })
    const s = enumerable({
      'mw:walrus:consume:testnet:g1:a': fresh,
      'mw:walrus:consume:testnet:g2:a': JSON.stringify({ digest: 'd', nftId: 'n', savedAt: now - CONSUME_RESUME_MAX_AGE_MS - 1 }),
      'mw:walrus:consume:testnet:g3:a': JSON.stringify({ digest: 'd', nftId: 'n', savedAt: now + 3_600_000 }),
      'mw:walrus:consume:testnet:g4:a': '{not json',
      'mw:walrus:pendingCertify:testnet:a': JSON.stringify({ x: { savedAt: 0 } }),
      'mw-color-mode': 'dark',
    })
    expect(forgetExpiredConsumes(s, now)).toBe(3)
    expect([...s.map.keys()].sort()).toEqual(['mw-color-mode', 'mw:walrus:consume:testnet:g1:a', 'mw:walrus:pendingCertify:testnet:a'])
  })

  // The sweep is part of opening storage, so an abandoned upload's record does not outlive its usefulness on the device.
  it('runs when browserStorage is created', () => {
    const s = enumerable({ 'mw:walrus:consume:testnet:g:a': JSON.stringify({ digest: 'd', nftId: 'n', savedAt: 0 }) })
    vi.stubGlobal('window', { localStorage: s })
    browserStorage()
    expect(s.map.size).toBe(0)
    vi.unstubAllGlobals()
  })
})

