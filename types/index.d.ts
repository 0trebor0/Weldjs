// Type declarations for WeldJS. Hand-written: the API is small enough that
// generating them would add a build step for no benefit.

import type { ServerResponse } from 'node:http';

/** A value that may be returned from a `<weld var="...">` block. */
export type Exportable =
  | string
  | number
  | boolean
  | null
  | Exportable[]
  | { [key: string]: Exportable };

export interface HtmlPart {
  readonly type: 'html';
  readonly buffer: Buffer;
}

export interface RequestPart {
  readonly type: 'request';
  readonly varName: string;
  readonly valueIndex: number;
  readonly handler: (request: unknown, response: unknown) => Promise<Exportable>;
}

export type Part = HtmlPart | RequestPart;

export interface CompileOptions {
  /** Path the page is treated as living at; sets what `require` resolves against. */
  filename?: string;
  /** Total serialized bytes one render may produce. Defaults to 1 MiB. */
  maxExportBytes?: number;
  /** Set false to silence the shared-setup-scope warning. */
  warnOnMutableSetup?: boolean;
}

export interface Page {
  readonly filename: string;
  /** Files pulled in by `<weld src>`. */
  readonly dependencies: readonly string[];
  readonly parts: readonly Part[];

  /**
   * An Express-compatible route handler. Renders, ends the response, and passes
   * any failure to `next`. Without `next`, returns the promise instead.
   */
  handler(request: unknown, response: unknown, next?: (error: unknown) => void): Promise<void> | undefined;

  /** Resolves every block concurrently, then writes the finished response. */
  render(request: unknown, response: ServerResponse | unknown): Promise<void>;

  /** Renders to a Buffer instead of a response. */
  renderToBuffer(request?: unknown, response?: unknown): Promise<Buffer>;
}

export interface LoadedPage extends Page {
  /** The compile promise. Reading it after a failure starts a fresh attempt. */
  readonly ready: Promise<Page>;
  /** Drops the compiled page so the next use rebuilds from disk. */
  invalidate(): Promise<Page>;
}

export interface WatchOptions {
  onChange?: (page: LoadedPage) => void;
  /** Extra files to watch. Defaults to the page's `<weld src>` dependencies. */
  dependencies?: string[];
}

export interface Watcher {
  readonly page: LoadedPage;
  readonly files: readonly string[];
  close(): void;
}

export interface RouterMiddleware {
  (request: unknown, response: unknown, next?: (error?: unknown) => void): unknown;
  /** Routes that were mounted, sorted. */
  readonly routes: readonly string[];
}

export interface ScannedPart {
  type: 'html' | 'weld';
  mode?: 'setup' | 'request' | 'include';
  src?: string;
  varName?: string;
  start?: number;
  end?: number;
  tagStart?: number;
  tagEnd?: number;
  codeStart?: number;
  codeEnd?: number;
}

export interface Budget {
  used: number;
  limit: number;
}

export declare class WeldSyntaxError extends SyntaxError {
  readonly offset: number;
  readonly line?: number;
  readonly column?: number;
}

/** Returns a page synchronously and compiles it in the background. */
export declare function load(filename: string): LoadedPage;

/** Empties the page cache and stops any watchers. */
export declare function clearLoaded(): void;

/** Recompiles a page when its file, or a file it includes, changes. */
export declare function watch(page: LoadedPage, options?: WatchOptions): Watcher;

/** Maps a directory of .html files to routes, resolved once at startup. */
export declare function router(directory: string): RouterMiddleware;

export declare function compileFile(filename: string): Promise<Page>;
export declare function compileSource(input: string | Buffer, options?: CompileOptions): Promise<Page>;

export declare function scan(input: string | Buffer): { source: Buffer; parts: ScannedPart[] };

export declare function serialize(value: Exportable, budget?: Budget): string;
export declare function assertSerializable(value: unknown, budget?: Budget): void;

/** A process-wide resource cache for setup blocks. */
export declare function shared<T>(key: string, factory: () => T | Promise<T>): Promise<T>;
export declare function clearShared(): void;

export declare const MAX_DEPTH: number;
export declare const MAX_EXPORT_BYTES: number;
