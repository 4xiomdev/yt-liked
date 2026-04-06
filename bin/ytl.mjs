#!/usr/bin/env node
import('../dist/cli.js').then(({ run }) => run(process.argv));
