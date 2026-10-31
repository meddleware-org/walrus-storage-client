// Node.js-only entry point for @meddleware/walrus-storage-client. Holds utilities that need the Node.js filesystem or other
// server-side APIs, in this module (not in `upload.ts`) so that a browser bundle of the main entry (".") never reaches a `node:`
// import: a browser bundler resolves every import it can see, even a dynamic one that never runs there.
//
// Usage: import { uploadLocalFile } from '@meddleware/walrus-storage-client/node'

import type { Signer } from '@mysten/sui/cryptography'
import { uploadBytes } from './upload.js'
import type { UploadOptions, UploadResult, WalrusClient } from './upload.js'

/**
 * Read a local file and upload it as a Walrus quilt. Node.js only.
 *
 * @throws {Error} if the file cannot be read or the upload fails.
 */
export async function uploadLocalFile(
  client: WalrusClient,
  filePath: string,
  identifier: string,
  signer: Signer,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { readFile } = await import('node:fs/promises')
  const contents = await readFile(filePath)
  return uploadBytes(client, new Uint8Array(contents), identifier, signer, options)
}
