/**
 * ClawMem File Watcher - fs.watch with debounce for incremental reindex
 *
 * Walks each directory tree at startup, skipping excluded dirs (gits/,
 * node_modules/, .git/, etc.), and watches only non-excluded directories.
 * This prevents inotify FD exhaustion on trees with large cloned repos.
 */

import { watch, readdirSync, statSync, type WatchEventType } from "fs";
import { join, relative } from "path";
import { shouldExclude, EXCLUDED_DIRS } from "./indexer.ts";

export type WatcherOptions = {
  debounceMs?: number;
  onChanged: (path: string, event: WatchEventType) => Promise<void>;
  onError?: (error: Error) => void;
};

/**
 * Walk a directory tree, returning only directories that are NOT excluded.
 * Stops recursion into excluded subtrees (gits/, node_modules/, .git/, etc.).
 */
function walkNonExcludedDirs(root: string): string[] {
  const dirs: string[] = [root];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue; // Permission denied or deleted
    }

    for (const entry of entries) {
      // Skip excluded directory names before stat
      if (EXCLUDED_DIRS.has(entry) || (entry.startsWith(".") && entry !== ".")) continue;

      const fullPath = join(current, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
          queue.push(fullPath);
        }
      } catch {
        // stat failed — skip
      }
    }
  }

  return dirs;
}

export function startWatcher(
  directories: string[],
  options: WatcherOptions
): { close: () => void } {
  const { debounceMs = 2000, onChanged, onError } = options;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const watchers: ReturnType<typeof watch>[] = [];

  for (const dir of directories) {
    // Walk the tree, skipping excluded dirs — watch each non-excluded dir individually
    const watchableDirs = walkNonExcludedDirs(dir);

    // Safety: warn and cap if a single collection path produces too many dirs
    const MAX_WATCH_DIRS = 500;
    if (watchableDirs.length > MAX_WATCH_DIRS) {
      console.log(`[watcher] WARNING: ${dir} has ${watchableDirs.length} dirs — capping at ${MAX_WATCH_DIRS} to prevent FD exhaustion. Consider narrowing the collection path.`);
      watchableDirs.length = MAX_WATCH_DIRS;
    } else {
      console.log(`[watcher] ${dir}: watching ${watchableDirs.length} dirs`);
    }

    for (const watchDir of watchableDirs) {
      try {
        // Non-recursive watch — each dir watched individually
        const watcher = watch(watchDir, (event, filename) => {
          if (!filename) return;
          // Accept .md files (indexing) and .jsonl only within .beads/ (Dolt backend)
          const isMd = filename.endsWith(".md");
          const isBeadsJsonl = filename.endsWith(".jsonl") && filename.includes(".beads/");
          if (!isMd && !isBeadsJsonl) return;

          const relativeToDirRoot = relative(dir, join(watchDir, filename));
          if (shouldExclude(relativeToDirRoot)) return;

          const fullPath = join(watchDir, filename);
          const existing = pending.get(fullPath);
          if (existing) clearTimeout(existing);

          pending.set(fullPath, setTimeout(async () => {
            pending.delete(fullPath);
            try {
              await onChanged(fullPath, event);
            } catch (err) {
              onError?.(err instanceof Error ? err : new Error(String(err)));
            }
          }, debounceMs));
        });
        watcher.on("error", (err) => {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        });
        watchers.push(watcher);
      } catch (err) {
        // Individual dir watch failure is non-fatal — skip it
        if (onError) {
          onError(err instanceof Error ? err : new Error(`Failed to watch ${watchDir}: ${err}`));
        }
      }
    }
  }

  return {
    close: () => {
      for (const w of watchers) w.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
  };
}
