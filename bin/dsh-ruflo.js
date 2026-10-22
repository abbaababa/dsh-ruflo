#!/usr/bin/env node
/**
 * dsh-ruflo installer.
 *
 * Installs this package into a DeepSeek Harness profile through the official
 * `dsh plugin` command, then selects the bundle in the profile manifest.
 * A running DSH may load the bundle through its profile watcher (HMR); if
 * `ruflo_status` reports reloadRequired, restart DSH once or toggle the row.
 * A registry that lags behind npmjs is retried once against registry.npmjs.org.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const NAME = 'dsh-ruflo';
const SELF = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `dsh-ruflo ${SELF.version} — install the official Ruflo bridge into DeepSeek Harness.

Usage:
  npx ${NAME}@${SELF.version} install [--profile <name>] [--registry <url>] [--dry-run]
  npx ${NAME}@${SELF.version} --version
  npx ${NAME}@${SELF.version} --help

install:
  1. runs \`dsh plugin --profile <name> add ${NAME}@${SELF.version}\`;
  2. adds "${NAME}" to dsh.profile.bundles in the profile package.json;
  3. leaves loading to DSH: its watcher may hot-load the bundle, and if
     ruflo_status reports reloadRequired, restart DSH once or toggle the row.

Options:
  --profile <name>  DSH profile to install into (default: $DSH_PROFILE or "web").
  --registry <url>  Registry for this install (default: your pnpm registry).
                    If that registry has not synced this version yet, the
                    installer retries once against https://registry.npmjs.org/.
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
    registry: undefined,
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
    } else if (argument === '--registry') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-') || !/^https?:\/\//.test(value)) {
        fail('--registry needs an http(s) URL');
      }
      options.registry = value;
      index += 1;
    } else if (argument.startsWith('--registry=')) {
      const value = argument.slice('--registry='.length);
      if (!/^https?:\/\//.test(value)) fail('--registry needs an http(s) URL');
      options.registry = value;
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

const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

function pluginArgs(options, spec, registry) {
  const args = ['plugin', '--profile', options.profile, 'add', spec];
  if (registry !== undefined) args.push(`--config.registry=${registry}`);
  return args;
}

function runPlugin(dsh, args, directory) {
  const result = spawnSync(dsh, args, {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

function install(options) {
  const directory = profileDirectory(options.profile);
  const manifest = readManifest(directory, options.profile);
  if (manifest.name === undefined) {
    fail(`${join(directory, 'package.json')} has no "name"; is this a DSH profile?`);
  }
  const dsh = resolveDsh();
  const spec = `${NAME}@${SELF.version}`;
  const args = pluginArgs(options, spec, options.registry);
  const command = `${dsh} ${args.join(' ')}`;

  if (options.dryRun) {
    console.log(`profile: ${directory}`);
    console.log(`step 1: ${command}`);
    console.log(`step 2: add "${NAME}" to dsh.profile.bundles in ${join(directory, 'package.json')}`);
    console.log('step 3: DSH may hot-load it; if ruflo_status reports reloadRequired, restart DSH once');
    return;
  }

  console.log(`Installing ${spec} into DSH profile "${options.profile}"...`);
  let result = runPlugin(dsh, args, directory);
  if (result.error) fail(`cannot run "${dsh}": ${result.error.message}`);
  let output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (
    result.status !== 0 &&
    /NO_MATCHING_VERSION|No matching version found/i.test(output) &&
    options.registry !== OFFICIAL_REGISTRY
  ) {
    console.log('');
    console.log(`The configured registry has not synced ${spec} yet; retrying with ${OFFICIAL_REGISTRY}`);
    result = runPlugin(dsh, pluginArgs(options, spec, OFFICIAL_REGISTRY), directory);
    if (result.error) fail(`cannot run "${dsh}": ${result.error.message}`);
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  }
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
  console.log('Verify inside DSH: call ruflo_status, or open the Ruflo status panel.');
  console.log('If ruflo_status reports reloadRequired, restart DSH once (or toggle the dsh-ruflo-plugin row).');
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
