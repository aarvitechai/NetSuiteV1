/**
 * File transport: how we exchange files with the bank (SFTP).
 *
 * Folder convention (the same on a real bank SFTP server, though names vary by bank):
 *   outbound/            files WE send (payment files), which the bank picks up
 *   inbound/             files the BANK sends (acknowledgements, statuses, statements), which we pick up
 *   archive/outbound/    copy of every file we sent (audit evidence, 7-year retention)
 *   archive/inbound/     every inbound file after processing
 *   quarantine/          inbound files we could not parse, kept for investigation, never deleted
 *
 * LocalFolderSftp uses a local folder instead of a real SFTP server, so everything can run on a laptop.
 * A production adapter (for example using the `ssh2-sftp-client` package) implements the same interface
 * with key-based authentication, a host-key pin and a connection timeout.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ValidationError } from '../../shared/errors';

/** 'bank/received' is used only by the bank SIMULATOR to keep the files it picked up. */
export type Folder =
  'outbound' | 'inbound' | 'archive/outbound' | 'archive/inbound' | 'quarantine' | 'bank/received';

export interface FileTransport {
  put(folder: Folder, name: string, content: string): Promise<void>;
  get(folder: Folder, name: string): Promise<string>;
  list(folder: Folder): Promise<string[]>;
  move(from: Folder, name: string, to: Folder): Promise<void>;
}

/**
 * Only simple file names are allowed.
 * WHY: a file name like "../../etc/passwd" coming from the bank side could otherwise make us read or
 * write outside the SFTP folder (path traversal).
 */
export function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) || name.includes('..')) {
    throw new ValidationError(`Unsafe file name "${name}"`);
  }
}

/** ⚠️ LOCAL STAND-IN for the bank's SFTP server. */
export class LocalFolderSftp implements FileTransport {
  constructor(private readonly root: string) {}

  private async dir(folder: Folder): Promise<string> {
    const d = resolve(this.root, folder);
    await mkdir(d, { recursive: true });
    return d;
  }

  async put(folder: Folder, name: string, content: string): Promise<void> {
    assertSafeName(name);
    // Write to a temp name, then rename: the reader never sees a half-written file (atomic publish).
    const d = await this.dir(folder);
    const tmp = resolve(d, `.${name}.part`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, resolve(d, name));
  }

  async get(folder: Folder, name: string): Promise<string> {
    assertSafeName(name);
    return readFile(resolve(await this.dir(folder), name), 'utf8');
  }

  async list(folder: Folder): Promise<string[]> {
    const entries = await readdir(await this.dir(folder), { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  }

  async move(from: Folder, name: string, to: Folder): Promise<void> {
    assertSafeName(name);
    const target = await this.dir(to);
    let dest = resolve(target, name);
    // Never overwrite an archived file. Add a suffix instead (keeps the evidence).
    const existing = new Set(await this.list(to));
    if (existing.has(name)) dest = resolve(target, `${name}.${Date.now()}`);
    await rename(resolve(await this.dir(from), name), dest);
  }
}
