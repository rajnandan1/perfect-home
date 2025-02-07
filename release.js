#!/usr/bin/env node

import {exec} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import semver from 'semver';
import ora from 'ora';
import chalk from 'chalk';
import indent from 'detect-indent';
import inquirer from 'inquirer';
import open from 'open';
import Git from 'simple-git';


const git = Git();
const cwd = process.cwd();

const manifests = [ 'package.json', 'src/manifest.json' ];
const addonUrl = 'https://addons.mozilla.org/en-US/developers/addon/perfect-home/versions';
const chromeStoreDash = 'https://chrome.google.com/webstore/devconsole';
const dryrun = false;


const faker = () => new Promise(resolve => setTimeout(resolve, 200));

function run (cmd) {
	if (dryrun) return faker();
	return new Promise((resolve, reject) => {
		exec(cmd, (err, out) => (err ? reject(err) : resolve(out)));
	});
}

function getJson (_path) {
	try {
		const file = fs.readFileSync(_path, 'utf8');
		const json = JSON.parse(file);
		return json || {};
	}
	catch {
		return {};
	}
}


function getVersion (manifest) {
	const pkgPath = path.join(cwd, manifest || manifests[0]);
	const pkg = getJson(pkgPath);
	const current = pkg.version || '0.0.0';

	return {
		name: pkg.name,
		current: current,
		nextMajor: semver.inc(current, 'major'),
		nextMinor: semver.inc(current, 'minor'),
		nextPatch: semver.inc(current, 'patch')
	};
}


function bump (manifest, newVersion) {
	const pkgPath = path.join(cwd, manifest);
	const pkg = getJson(pkgPath);
	const usedIndent = indent(fs.readFileSync(pkgPath, 'utf8')).indent || '  ';
	pkg.version = newVersion;
	if (!dryrun) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, usedIndent) + '\n');
}

// remove chrome_settings_overrides property from manifest.json
// as chrome store doesn't allow that
function updateManifestForChrome (pkgPath) {
	pkgPath = pkgPath.replace('~', os.homedir);
	const pkg = getJson(pkgPath);
	const usedIndent = indent(fs.readFileSync(pkgPath, 'utf8')).indent || '  ';
	delete pkg.chrome_settings_overrides;
	if (!dryrun) fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, usedIndent) + '\n');
}


function commit (version) {
	if (dryrun) return faker();
	return new Promise((resolve, reject) => {
		git
			.silent(true)
			.add('./*')
			.commit('Release v' + version)
			.push(['origin', 'master'], err => {
				if (err) reject(err);
				else resolve({version});
			});
	});
}


function release () {
	const config = getJson('./config-prod.json');
	const app = getVersion();
	let spinner;
	console.log('\n**************************************');
	console.log('*                                    *');
	console.log(`*      Releasing ${chalk.cyan(app.name)}        *`);
	console.log('*                                    *');
	console.log('**************************************\n');
	inquirer
		.prompt([
			{
				type: 'list',
				name: 'version',
				message: 'Bump version to:',
				default: 1,
				choices: [
					{ value: app.current,   name: 'current (' + app.current + ')' },
					{ value: app.nextPatch, name: 'patch   (' + app.nextPatch + ')' },
					{ value: app.nextMinor, name: 'minor   (' + app.nextMinor + ')' },
					{ value: app.nextMajor, name: 'major   (' + app.nextMajor + ')' },
					new inquirer.Separator(),
					{ value: 'custom', name: 'custom...' },
				]
			},
			{
				type: 'input',
				name: 'version',
				message: 'Enter the new version number:',
				default: app.current,
				when: answers => answers.version === 'custom',
				filter: semver.clean,
				validate: answer => semver.valid(answer) ? true : 'That\'s not a valid version number',
			}
		])
		.then(({version}) => {
			app.version = version;
			spinner = ora('').start();
			// update package & manifest
			manifests.forEach(m => {
				spinner.text = `Updating ${m}...`;
				bump(m, version);
				spinner.text = `Updated ${chalk.cyan(m)} to ${chalk.cyan(version)}`;
				spinner.succeed();
			});
			spinner.text = 'Committing to GitHub...';
			spinner.start();
			return commit(version);              // commit code changes to  github
		})
		.then(() => {
			spinner.text = `Update ${chalk.cyan('pushed')} to Github.`;
			spinner.succeed();

			spinner.text = 'Building a ' + chalk.cyan('production') + ' version.';
			spinner.start();
			return run('gulp build --prod');
		})
		.then(() => {
			spinner.text = 'Built a ' + chalk.cyan('production') + ' version.';
			spinner.succeed();


			spinner.text = 'Publishing addon to mozilla...';
			spinner.start();

			const signCmd = path.resolve('./', 'node_modules/.bin/web-ext') +
				' sign --channel=listed' +
				' --api-secret=' + config.apiSecret +
				' --api-key=' + config.apiKey;
			return run(signCmd).catch(() => {});
		})
		.then(() => {
			spinner.text = 'Signed & published to ' + chalk.cyan('mozilla') + '!';
			spinner.succeed();

			spinner.text = 'Zipping source...';
			spinner.start();

			const cmd = 'mkdir ~/Desktop/source && ' +
				'cp -R src ~/Desktop/source && ' +
				'cp package.json ~/Desktop/source && ' +
				'cp gulpfile.js ~/Desktop/source && ' +
				'7z a ~/Desktop/source.zip ~/Desktop/source/ > /dev/null && ' +
				'rm -rf ~/Desktop/source';
			return run(cmd).catch(() => {});
		})
		.then(() => {
			spinner.text = 'Source zipped to ' + chalk.cyan('Desktop') + '!';
			spinner.succeed();

			spinner.text = 'Zipping dist for chrome store...';
			spinner.start();
			const name = `${app.name}-${app.version}`;
			const cmd = `mkdir ~/Desktop/${name} && cp -R dist/* ~/Desktop/${name}`;
			return run(cmd).catch(() => {});
		})
		.then(() => {
			const name = `${app.name}-${app.version}`;
			updateManifestForChrome(`~/Desktop/${name}/manifest.json`);

			const cmd = `7z a ~/Desktop/${name}.zip ~/Desktop/${name}/ > /dev/null && ` +
				`rm -rf ~/Desktop/${name}`;
			return run(cmd).catch(() => {});
		})
		.then(() => {
			spinner.text = 'Chrome store package zipped to ' + chalk.cyan('Desktop') + '!';
			spinner.succeed();

			console.log(chalk.cyan('All done!'));
			if (!dryrun) open(addonUrl);
			if (!dryrun) open(chromeStoreDash);
			process.exit(0);
		})
		.catch(e => {
			spinner.text = '' + e;
			spinner.fail();
		});
}


release();
