/**
 * Finding speech servers orphaned by a run of this app that died abnormally.
 *
 * The server is a child process, and it outlives its parent if Electron dies
 * without shutting down — a native abort in an addon, say — leaving it holding
 * a port and ~500 MB of GPU memory. macOS re-parents an orphan to launchd, PID
 * 1, and that is what tells it apart from a working server that belongs to some
 * other live process: a second copy of the app, a self-test, a benchmark.
 *
 * This used to go by a PID file that every process using the same settings
 * shared. A self-test or benchmark started while the app was running read the
 * app's entry, took its live server for a leftover and killed it — and the app
 * answered every command after that with "speech engine not started".
 *
 * Pure, so it is tested without processes.
 */

/**
 * PIDs of orphaned whisper servers, from `ps -axo pid=,ppid=,command=`.
 * `marker` narrows it to servers loading a model from this app's own folder.
 */
export function orphanedServers(listing: string, marker: string): number[] {
  const out: number[] = [];
  for (const line of listing.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m as unknown as [string, string, string, string];
    if (ppid !== "1") continue;
    if (!/(^|\/)whisper-server(\s|$)/.test(command) || !command.includes(marker)) continue;
    out.push(Number(pid));
  }
  return out;
}
