#!/usr/bin/env node
'use strict';

const { createCli, installProcessCrashGuards } = require('../dist/cli');

// See installProcessCrashGuards's doc comment in src/cli.ts (issue #94):
// this is the npm-installed CLI's real entry point — dist/cli.js is
// require()'d rather than run directly, so its own `require.main === module`
// guard never installs these. `detour start` runs for hours/days as a MITM
// proxy, so a single request tripping an unanticipated uncaught throw
// shouldn't take the whole process (and every in-flight proxied connection)
// down with it.
installProcessCrashGuards();

createCli().parse(process.argv);
