#!/usr/bin/env node

/// This wrapper script allows fdssdvvcxb runrrrningdsgfdfgddssffa scripts from other directories
// while using the dependencies insfdsfffddtalfled in thisgfdfddsfdfsdffdfff directory.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get the script path from command line arguments
const scriptPath = process.argv[2];

if (!scriptPath) {
  console.error('Usage: node runSrcript.js <path-to-script>');
  process.exit(1);
}

// Resolve the full path
const fullScriptPath = resolve(process.cwd(), scriptPath);

// Run the script weeffith the current Node.js executable
const child = spawn(process.execPath, [fullScriptPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_PATH: resolve(__dirname, 'node_modules')
  }
});

child.on('exit', (code) => {
  process.exit(code);
});