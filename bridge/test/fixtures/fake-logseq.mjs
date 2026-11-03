#!/usr/bin/env node
// Test stand-in for the `logseq` CLI: echoes its argv as JSON, prints help for --help.
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write('Usage: logseq fake\n  --page <name>\n  --content <text>\n');
  process.exit(0);
}
if (argv[0] === '--version') {
  process.stdout.write('fake-logseq 0.0.0\n');
  process.exit(0);
}
if (argv.includes('--page=__fail__')) {
  process.stderr.write('simulated failure\n');
  process.exit(3);
}
if (argv.includes('--page=__env__')) {
  process.stdout.write(JSON.stringify({ status: 'ok', env: Object.keys(process.env).sort() }) + '\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: 'ok', argv }) + '\n');
