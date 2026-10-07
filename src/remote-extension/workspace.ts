import { posix } from "node:path";
import { BridgeError } from "../core/errors.js";

const REMOTE_WORKSPACE_SCHEMES = new Set(["file", "vscode-remote"]);

function normalizeAbsoluteRemotePath(value: string): string | null {
  if (!posix.isAbsolute(value)) {
    return null;
  }
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function matchesRemoteWorkspaceRoot(
  folder: { path: string; scheme: string },
  workspaceRoot: string,
): boolean {
  if (!REMOTE_WORKSPACE_SCHEMES.has(folder.scheme)) {
    return false;
  }
  const folderPath = normalizeAbsoluteRemotePath(folder.path);
  const requestedPath = normalizeAbsoluteRemotePath(workspaceRoot);
  return folderPath !== null && requestedPath !== null && folderPath === requestedPath;
}

export function remoteExecutionRoot(
  workspaceRoot: string,
  scopeRoot: unknown,
  homeDirectory: string,
): string {
  if (scopeRoot === undefined) {
    return workspaceRoot;
  }
  if (scopeRoot !== homeDirectory || homeDirectory === "/") {
    throw new BridgeError(
      "PATH_OUTSIDE_ROOT",
      "Remote execution scope does not match the remote user's home directory",
    );
  }
  return homeDirectory;
}
