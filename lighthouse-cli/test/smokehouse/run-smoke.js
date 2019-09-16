/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/** @typedef {{onlyAudits: string[], onlyBatches: string[], onlyUrls: string[]}} CliArgs */

/* eslint-disable no-console */
const {promisify} = require('util');
const execAsync = promisify(require('child_process').exec);
const yargs = require('yargs');

const {server, serverForOffline} = require('../fixtures/static-server.js');
const log = require('lighthouse-logger');

/** @param {string} str */
const purpleify = str => `${log.purple}${str}${log.reset}`;
const SMOKETESTS = require('./smoke-test-dfns.js').SMOKE_TEST_DFNS;

/**
 * Display smokehouse output from child process
 * @param {{id: string, stdout: string, stderr: string, error?: Error}} result
 */
function displaySmokehouseOutput(result) {
  console.log(`\n${purpleify(result.id)} smoketest results:`);
  if (result.error) {
    console.log(result.error.message);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.timeEnd(`smoketest-${result.id}`);
  console.log(`${purpleify(result.id)} smoketest complete. \n`);
  return result;
}

/**
 * Run smokehouse in child processes for selected smoketests
 * Display output from each as soon as they finish, but resolve function when ALL are complete
 * @param {Array<Smokehouse.TestDfn>} smokes
 * @param {CliArgs} argv
 * @return {Promise<Array<{id: string, error?: Error}>>}
 */
async function runSmokehouse(smokes, argv) {
  const cmdPromises = [];
  for (const {id, expectations, config} of smokes) {
    console.log(`${purpleify(id)} smoketest starting…`);
    console.time(`smoketest-${id}`);
    const commandParts = [
      'node lighthouse-cli/test/smokehouse/smokehouse.js',
      `--config-path=${config}`,
      `--expectations-path=${expectations}`,
    ];
    if (argv.onlyAudits) commandParts.push(`--only-audits ${argv.onlyAudits.join(' ')}`);
    if (argv.onlyUrls) commandParts.push(`--only-urls ${argv.onlyUrls.join(' ')}`);
    const cmd = commandParts.join(' ');
    console.log(cmd);

    // The promise ensures we output immediately, even if the process errors
    const p = execAsync(cmd, {timeout: 6 * 60 * 1000, encoding: 'utf8'})
      .then(cp => ({id, ...cp}))
      .catch(err => ({id, stdout: err.stdout, stderr: err.stderr, error: err}))
      .then(result => displaySmokehouseOutput(result));

    // If the machine is terribly slow, we'll run all smoketests in succession, not parallel
    if (process.env.APPVEYOR) {
      await p;
    }
    cmdPromises.push(p);
  }

  return Promise.all(cmdPromises);
}

/**
 * Determine batches of smoketests to run, based on argv
 * @param {string[]} argv
 * @return {Map<string|undefined, Array<Smokehouse.TestDfn>>}
 */
function getSmoketestBatches(argv) {
  let smokes = [];
  const usage = `    ${log.dim}yarn smoke ${SMOKETESTS.map(t => t.id).join(' ')}${log.reset}\n`;

  if (argv.length === 0) {
    smokes = SMOKETESTS;
    console.log('Running ALL smoketests. Equivalent to:');
    console.log(usage);
  } else {
    smokes = SMOKETESTS.filter(test => argv.includes(test.id));
    console.log(`Running ONLY smoketests for: ${smokes.map(t => t.id).join(' ')}\n`);
  }

  const unmatchedIds = argv.filter(requestedId => !SMOKETESTS.map(t => t.id).includes(requestedId));
  if (unmatchedIds.length) {
    console.log(log.redify(`Smoketests not found for: ${unmatchedIds.join(' ')}`));
    console.log(usage);
  }

  // Split into serial batches that will run their tests concurrently
  const batches = smokes.reduce((map, test) => {
    const batch = map.get(test.batch) || [];
    batch.push(test);
    return map.set(test.batch, batch);
  }, new Map());

  return batches;
}

/**
 * Main function. Run webservers, smokehouse, then report on failures
 * @param {CliArgs} argv
 */
async function cli(argv) {
  server.listen(10200, 'localhost');
  serverForOffline.listen(10503, 'localhost');

  const batches = getSmoketestBatches(argv.onlyBatches);

  const smokeDefns = new Map();
  const smokeResults = [];
  for (const [batchName, batch] of batches) {
    console.log(`Smoketest batch: ${batchName || 'default'}`);
    for (const defn of batch) {
      smokeDefns.set(defn.id, defn);
    }

    const results = await runSmokehouse(batch, argv);
    smokeResults.push(...results);
  }

  let failingTests = smokeResults.filter(result => !!result.error);

  // Automatically retry failed tests in CI to prevent flakes
  if (failingTests.length && (process.env.RETRY_SMOKES || process.env.CI)) {
    console.log('Retrying failed tests...');
    for (const failedResult of failingTests) {
      /** @type {number} */
      const resultIndex = smokeResults.indexOf(failedResult);
      const smokeDefn = smokeDefns.get(failedResult.id);
      smokeResults[resultIndex] = (await runSmokehouse([smokeDefn], argv))[0];
    }
  }

  failingTests = smokeResults.filter(result => !!result.error);

  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => serverForOffline.close(resolve));

  if (failingTests.length) {
    const testNames = failingTests.map(t => t.id).join(', ');
    console.error(log.redify(`We have ${failingTests.length} failing smoketests: ${testNames}`));
    process.exit(1);
  }

  process.exit(0);
}

const argv = yargs
  .help('help')
  .describe({
    'only-audits': 'Filter for audit expectations to run',
    'only-urls': 'Filter for urls to run. Patterns accepted',
  })
  .array('only-audits')
  .array('only-urls')
  .example('yarn smoke --only-audits network-requests',
    'Only run tests for the network-request audit')
  .example('yarn smoke --only-urls http://localhost:10200/preload.html',
    'Only run tests for http://localhost:10200/preload.html')
  .wrap(yargs.terminalWidth())
  .argv;

cli({
  onlyAudits: argv['only-audits'],
  onlyBatches: argv['_'], // Positional args.
  onlyUrls: argv['only-urls'],
}).catch(e => {
  console.error(e);
  process.exit(1);
});
