/**
 * Turning a function's code on disk into the zip `functions deploy` uploads.
 *
 * Local only, no network: everything here can fail before a single request is
 * sent, which is the point — a bad name, a missing file or an oversized folder
 * should cost the user nothing but the error.
 *
 * The layout is Supabase's, so `supabase functions deploy hello` becomes
 * `naijacloud functions deploy hello` in the same checkout: the entry file sits
 * at the zip root, `index.ts` unless `--entry` says otherwise.
 */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { createZip } from "../deploy-static/zip.js";
import type { ZipInput } from "../deploy-static/zip.js";

/** 1–40 characters: lower case, digits and dashes, no dash at either end. */
export const FUNCTION_NAME = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** The per-deploy code limit, checked here so an oversized deploy never uploads. */
export const MAX_CODE_BYTES = 20 * 1024 * 1024;

/** Extensions a single-file function may have; it is zipped as `index.<ext>`. */
const SINGLE_FILE_EXTENSIONS = [".ts", ".js", ".mjs"];

/** Entry files looked for at a folder's root, in this order. */
const DEFAULT_ENTRIES = ["index.ts", "index.js", "index.mjs"];

export function isValidFunctionName(name: string): boolean {
  return FUNCTION_NAME.test(name);
}

/**
 * The nearest valid name to what was typed — `Send_Receipt` → `send-receipt` —
 * or the documented example when nothing usable is left.
 */
export function suggestFunctionName(name: string): string {
  const suggestion = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return isValidFunctionName(suggestion) ? suggestion : "send-receipt";
}

/** The designer's copy for an invalid name (F7). */
export function invalidNameMessage(name: string): string {
  return (
    "Function names use lower-case letters, numbers and dashes, up to 40 " +
    `characters. Try ${suggestFunctionName(name)}.`
  );
}

/** "0.4 KB", "3.1 MB": one decimal, the precision the F7 output shows. */
export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where the code is: one file, or a folder whose root holds the entry file. */
export interface FunctionSource {
  kind: "file" | "folder";
  /** Absolute path. */
  path: string;
  /** As the user would write it, relative to the working directory: `hello.ts`, `functions/hello/`. */
  label: string;
}

export interface FunctionBundle {
  source: FunctionSource;
  /** Entry file at the zip root. */
  entrypoint: string;
  files: number;
  /** Bytes of the files before compression. */
  sourceBytes: number;
  zip: Buffer;
}

function label(cwd: string, absolute: string, folder: boolean): string {
  const relative = path.relative(cwd, absolute);
  const shown = relative === "" ? "." : relative.startsWith("..") ? absolute : relative;
  return folder && !shown.endsWith(path.sep) ? `${shown}${path.sep}` : shown;
}

function isFolder(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the code for `name`: `--file` when given, otherwise the first of
 * `./<name>.ts`, `./supabase/functions/<name>/`, `./functions/<name>/` and
 * `./<name>/` that exists.
 */
export function locateFunctionSource(name: string, cwd: string, file?: string): FunctionSource {
  if (file !== undefined) {
    const absolute = path.resolve(cwd, file);
    if (isFolder(absolute)) return { kind: "folder", path: absolute, label: label(cwd, absolute, true) };
    if (isFile(absolute)) return { kind: "file", path: absolute, label: label(cwd, absolute, false) };
    throw new Error(`${file} does not exist. Pass --file a .ts, .js or .mjs file, or a folder.`);
  }

  const single = path.join(cwd, `${name}.ts`);
  if (isFile(single)) return { kind: "file", path: single, label: label(cwd, single, false) };

  const folders = [
    path.join(cwd, "supabase", "functions", name),
    path.join(cwd, "functions", name),
    path.join(cwd, name),
  ];
  for (const folder of folders) {
    if (isFolder(folder)) return { kind: "folder", path: folder, label: label(cwd, folder, true) };
  }

  throw new Error(
    `No code found for ${name}. Looked for ./${name}.ts, ./supabase/functions/${name}/, ` +
      `./functions/${name}/ and ./${name}/. Pass --file <path> to point at it.`,
  );
}

/**
 * Whether a path inside a function folder stays out of the zip: dependencies
 * (the build installs package.json's itself), version control, `.env` files
 * (variables are the project's, set on the platform) and every other dotfile.
 * package.json, package-lock.json, deno.json(c) and tsconfig.json always go in:
 * a Node-style function's npm dependencies come from them.
 */
export function isExcluded(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => segment === "node_modules" || segment.startsWith("."));
}

/** Every regular file under `root`, as forward-slashed paths relative to it, sorted. */
function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (isExcluded(relative)) continue;
      const absolute = path.join(dir, entry);
      // lstat, so a symlink is never followed out of the folder.
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) visit(absolute, relative);
      else if (stats.isFile()) found.push(relative);
    }
  };
  visit(root, "");
  return found;
}

/**
 * Builds the upload: a single file becomes `index.<ext>` at the zip root; a
 * folder is zipped with its contents at the root and must hold its entry file
 * there (`--entry`, else index.ts, index.js or index.mjs).
 */
export function bundleFunction(source: FunctionSource, entry?: string): FunctionBundle {
  let inputs: ZipInput[];
  let entrypoint: string;

  if (source.kind === "file") {
    const extension = path.extname(source.path).toLowerCase();
    if (!SINGLE_FILE_EXTENSIONS.includes(extension)) {
      throw new Error(`${source.label} is not a .ts, .js or .mjs file.`);
    }
    if (entry !== undefined) {
      throw new Error(
        `--entry is for a folder. A single file is always deployed as index${extension}.`,
      );
    }
    entrypoint = `index${extension}`;
    inputs = [{ path: entrypoint, contents: readFileSync(source.path) }];
  } else {
    const files = walk(source.path);
    const wanted = entry?.replace(/^\.\//, "");
    if (wanted !== undefined) {
      if (!files.includes(wanted)) {
        throw new Error(`${source.label} has no ${wanted} at its top level, so --entry cannot use it.`);
      }
      entrypoint = wanted;
    } else {
      const found = DEFAULT_ENTRIES.find((candidate) => files.includes(candidate));
      if (found === undefined) {
        throw new Error(
          `${source.label} has no index.ts, index.js or index.mjs. ` +
            "Add one, or name the entry file with --entry.",
        );
      }
      entrypoint = found;
    }
    inputs = files.map((relative) => ({
      path: relative,
      contents: readFileSync(path.join(source.path, ...relative.split("/"))),
    }));
  }

  const { buffer, uncompressedBytes } = createZip(inputs);
  return { source, entrypoint, files: inputs.length, sourceBytes: uncompressedBytes, zip: buffer };
}

/** The refusal for an oversized deploy, or null when it fits. */
export function sizeProblem(bytes: number, limit = MAX_CODE_BYTES): string | null {
  if (bytes <= limit) return null;
  // Rounded up, so a deploy just over the line never reads as "20.0 MB".
  const size = (Math.ceil((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
  const cap = Number((limit / (1024 * 1024)).toFixed(1));
  return `Code is ${size} MB; the limit is ${cap} MB per deploy.`;
}
