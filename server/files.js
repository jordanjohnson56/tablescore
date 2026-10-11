// File checks shared by the import CLIs.
import { statSync } from "node:fs";

/**
 * Throw a clear error unless file is an existing file. kind names what it should
 * be, e.g. "a spreadsheet", for the message when it's a folder.
 */
export function checkFile(file, kind) {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new Error(`No file at ${file}`);
  }
  // What Docker hands you when a -v source path doesn't exist on the host.
  if (st.isDirectory()) throw new Error(`${file} is a folder, not ${kind}. If you mounted it with docker -v, the host path was wrong.`);
}
