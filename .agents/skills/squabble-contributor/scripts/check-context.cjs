const { check, main, parseArgs, print, workspace } = require('./context-lib.cjs');
main(() => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node check-context.cjs [--repo PATH] [--json]\nValidate manifest paths, skill Markdown links and architecture IDs in the selected checkout/worktree.\nExit 1 for structural errors; drift or an unavailable local baseline produces warnings, not semantic assurance.\nRead-only; never fetches or updates knowledge.');
    return;
  }
  const result = check(workspace(args.repo));
  print(result);
  if (!result.valid) process.exitCode = 1;
});
