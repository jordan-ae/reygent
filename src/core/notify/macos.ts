/** Native macOS desktop notifications via `osascript`. */

import { execFile } from "node:child_process";

// The message, title and sound are passed as arguments rather than interpolated into
// the script, so text scraped from job listings can never be executed as AppleScript.
const SCRIPT =
  "on run argv\n" +
  "display notification (item 1 of argv) with title (item 2 of argv) sound name (item 3 of argv)\n" +
  "end run";

export type Notifier = (message: string) => void;

/** Show a desktop notification. Resolves false if it could not be delivered. */
export function notifyMacos(message: string, title = "Reygent", sound = "Glass"): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile("osascript", ["-e", SCRIPT, message, title, sound], { timeout: 10_000 }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

/** Fire-and-forget notifier for callers that must not wait on the desktop. */
export const notify: Notifier = (message) => {
  void notifyMacos(message);
};
