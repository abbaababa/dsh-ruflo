#!/usr/bin/env node
/**
 * dsh-ruflo installer.
 *
 * Installs this package into a DeepSeek Harness profile through the official
 * `dsh plugin` command, then selects the bundle in the profile manifest.
 * A running DSH watches that manifest (HMR) and loads the bundle without a
 * restart; when HMR is disabled the next DSH start loads it.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const NAME = 'dsh-ruflo';
const SELF = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `dsh-ruflo ${SELF.version} — install the official Ruflo bridge into DeepSeek Harness.

Usage:
  npx ${NAME}@${SELF.version} install [--profile <name>] [--dry-run]
  npx ${NAME}@${SELF.version} --version
  npx ${NAME}@${SELF.version} --help

install:
  1. runs \`dsh plugin --profile <name> add ${NAME}@${SELF.version}\`;
  2. adds "${NAME}" to dsh.profile.bundles in the profile package.json;
  3. leaves loading to DSH: its HMR watcher picks the change up while DSH is
     running, otherwise the next DSH start loads it.

Options:
  --profile <name>  DSH profile to install into (default: $DSH_PROFILE or "web").
  --dry-run         Print the exact steps without changing anything.
  --help            Show this help.
  --version         Print the version.

Environment:
  DSH_HOME          DSH home directory (default: ~/.dsh).
  DSH_PROFILE       Default profile name.
  DSH_BIN           dsh executable (default: dsh on PATH).
`;

function fail(message, code = 1) {
  console.error(`${NAME}: ${message}`);
  process.exit(code);
}

function parse(argv) {
  const options = {
    command: 'help',
    profile: process.env.DSH_PROFILE || 'web',
    dryRun: false,
  };
  let start = 0;
  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    options.command = argv[0];
    start = 1;
  }
  for (let index = start; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--profile') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) fail('--profile needs a profile name');
      options.profile = value;
      index += 1;
    } else if (argument.startsWith('--profile=')) {
      const value = argument.slice('--profile='.length);
      if (value === '') fail('--profile needs a profile name');
      options.profile = value;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--help' || argument === '-h') {
      options.command = 'help';
    } else if (argument === '--version' || argument === '-v') {
      options.command = 'version';
    } else {
      fail(`unknown argument: ${argument}\n\n${HELP}`);
    }
  }
  return options;
}

function profileDirectory(profile) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return resolve(home, 'profiles', profile);
}

function readManifest(directory, profile) {
  const file = join(directory, 'package.json');
  if (!existsSync(file)) {
    fail(
      `profile "${profile}" was not found at ${directory}.\n` +
        'Start DSH once to create the profile, or pass --profile <name>.',
    );
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function resolveDsh() {
  const binary = process.env.DSH_BIN || 'dsh';
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    fail(
      `cannot run "${binary}": ${probe.error.message}\n` +
        'Install DeepSeek Harness first, or set DSH_BIN to its executable.',
    );
  }
  if (probe.status !== 0) {
    fail(`"${binary} --version" exited with ${probe.status}.`);
  }
  return binary;
}

function registerBundle(directory, profile) {
  const file = join(directory, 'package.json');
  const manifest = readManifest(directory, profile);
  const current = manifest.dsh?.profile?.bundles;
  if (current !== undefined && !Array.isArray(current)) {
    fail(`dsh.profile.bundles in ${file} is not an array; fix it and retry.`);
  }
  if (Array.isArray(current) && current.includes(NAME)) {
    console.log(`${NAME} is already selected in dsh.profile.bundles.`);
    return;
  }
  const bundles = Array.isArray(current) ? [...current, NAME] : [NAME];
  const next = {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles },
    },
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak.${stamp}`;
  copyFileSync(file, backup);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temporary, file);
  console.log(`Selected "${NAME}" in dsh.profile.bundles (backup: ${backup}).`);
}

function install(options) {
  const directory = profileDirectory(options.profile);
  const manifest = readManifest(directory, options.profile);
  if (manifest.name === undefined) {
    fail(`${join(directory, 'package.json')} has no "name"; is this a DSH profile?`);
  }
  const dsh = resolveDsh();
  const spec = `${NAME}@${SELF.version}`;
  const command = `${dsh} plugin --profile ${options.profile} add ${spec}`;

  if (options.dryRun) {
    console.log(`profile: ${directory}`);
    console.log(`step 1: ${command}`);
    console.log(`step 2: add "${NAME}" to dsh.profile.bundles in ${join(directory, 'package.json')}`);
    console.log('step 3: DSH HMR loads it (or the next DSH start does)');
    return;
  }

  console.log(`Installing ${spec} into DSH profile "${options.profile}"...`);
  const result = spawnSync(dsh, ['plugin', '--profile', options.profile, 'add', spec], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (result.error) fail(`cannot run "${dsh}": ${result.error.message}`);
  if (result.status !== 0) {
    fail(`"${command}" exited with ${result.status}; nothing was selected.`, result.status ?? 1);
  }

  registerBundle(directory, options.profile);

  const installedFile = join(directory, 'node_modules', NAME, 'package.json');
  if (!existsSync(installedFile)) {
    fail(`installation reported success, but ${installedFile} is missing.`);
  }
  const installed = JSON.parse(readFileSync(installedFile, 'utf8'));
  if (installed.version !== SELF.version) {
    fail(`expected ${NAME}@${SELF.version}, found ${installed.version}.`);
  }

  console.log('');
  console.log(`✔ ${NAME}@${SELF.version} is installed in profile "${options.profile}".`);
  console.log('DSH loads it through its profile watcher; allow a few seconds.');
  console.log('Verify inside DSH: call ruflo_status, or open the Ruflo status panel.');
  console.log('If this DSH instance runs without HMR, restart it once.');
}

const options = parse(process.argv.slice(2));
switch (options.command) {
  case 'install':
    install(options);
    break;
  case 'version':
    console.log(SELF.version);
    break;
  case 'help':
    console.log(HELP);
    break;
  default:
    fail(`unknown command: ${options.command}\n\n${HELP}`);
}
