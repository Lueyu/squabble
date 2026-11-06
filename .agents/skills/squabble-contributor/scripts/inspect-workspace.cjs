const { inspect, main, parseArgs, print, workspace } = require('./context-lib.cjs');
main(() => {
  const args = parseArgs(process.argv.slice(2), ['--config']);
  if (args.help) {
    console.log('Usage: node inspect-workspace.cjs [--repo PATH] [--config PRIVATE_JSON] [--json]\nRead-only JSON report: local Git identity/drift, affected knowledge, entrypoints and migration registry.\n--repo selects a checkout or worktree (default current directory). --config reads locator hints only.\nNo fetch, dependency install, environment-file reads, URL probes or application actions.');
    return;
  }
  print(inspect(workspace(args.repo), args.config));
});
