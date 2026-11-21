// Input limits shared by the upload paths. No dependencies: `./flow` imports this without pulling
// `@mysten/walrus` (wasm) into an app's eager bundle.
//
// Role: the checks that must happen BEFORE a wallet prompt, because the failure they prevent (an on-chain abort) costs gas and a signature. Main exports:
// `MAX_SINGLE_RESERVATION_EPOCHS`, `assertEpochs`, `assertTipCapMist`. Tested in `tests/client.test.ts` and `tests/upload.test.ts`.

/**
 * Maximum epochs a SINGLE Walrus reservation accepts (`max_epochs_ahead` on the Walrus system
 * object; 53 on testnet/mainnet). Passing more to `writeBlob` / `writeFiles` aborts on-chain
 * (`reserve_space`, MoveAbort code 2), after a wallet prompt and gas. ~2 years at the ~2-week epoch
 * cadence. Paths that hold a client read the live value ({@link maxEpochsAhead}) and use this as the
 * fallback.
 */
export const MAX_SINGLE_RESERVATION_EPOCHS = 53

/**
 * `epochs` as a validated integer in `[1, max]`.
 *
 * @throws {RangeError} for 0, a negative or fractional number, NaN, or a value above `max`.
 */
export function assertEpochs(epochs: number, max: number = MAX_SINGLE_RESERVATION_EPOCHS): number {
  // A safe integer in [1, max]: NaN, a fraction, zero and a negative all fail the first test or the second.
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs > max) {
    throw new RangeError(`epochs must be an integer from 1 to ${max} (got ${String(epochs)}).`)
  }
  return epochs
}

/**
 * The relay tip cap in MIST as a validated positive safe integer.
 *
 * @throws {RangeError} for NaN, a non-integer, zero, a negative or an unsafe integer.
 */
export function assertTipCapMist(cap: number): number {
  // A positive safe integer: the SDK compares the relay's tip with it as a number of MIST.
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError(`uploadRelayMaxTipMist must be a positive safe integer of MIST (got ${String(cap)}).`)
  }
  return cap
}
