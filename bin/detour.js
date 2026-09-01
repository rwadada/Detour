#!/usr/bin/env node
'use strict';

const { createCli } = require('../dist/cli');

createCli().parse(process.argv);
