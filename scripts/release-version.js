'use strict';

// Decide what a pushed v* tag publishes. Used by .github/workflows/publish.yml.
//
// A full release (v1.2.3) must match package.json exactly, so what is in git
// is what is on npm.
//
// A prerelease (v1.2.3-dev.4) is a prerelease of the version package.json
// declares: its base (1.2.3) must equal package.json's version, so dev
// declares the line being worked on and only that line's prereleases can be
// tagged. npm publishes whatever version package.json holds, so the workflow
// sets the tag's version in its own checkout before testing and publishing;
// nothing is committed, and the provenance attestation names the commit.
//
// Either kind must also be newer than npm's current `latest`, when there is
// one: a full release lower than it would move `latest` backwards, and a
// prerelease of an already-released line would sort below what users have.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function parse (version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || null };
}

function compareCore (a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function plan (tag, packageVersion, latestVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error(`tag ${tag} does not start with "v"`);
  }
  const version = tag.slice(1);
  const tagged = parse(version);
  if (!tagged) {
    throw new Error(`tag ${tag} is not a version (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-PRERELEASE, no build metadata)`);
  }
  const declared = parse(packageVersion);
  if (!declared) {
    throw new Error(`package.json version ${packageVersion} is not a version`);
  }
  const latest = latestVersion ? parse(latestVersion) : null;
  if (latestVersion && !latest) {
    throw new Error(`npm latest version ${latestVersion} is not a version`);
  }
  if (latest && compareCore(tagged.core, latest.core) <= 0) {
    throw new Error(`tag ${tag} is not newer than npm's latest ${latestVersion}; `
      + (tagged.prerelease ? 'a prerelease must lead the latest release' : 'publishing it would move latest backwards'));
  }

  if (!tagged.prerelease) {
    if (version !== packageVersion) {
      throw new Error(`tag ${tag} does not match package.json version ${packageVersion}; a full release must match exactly`);
    }
    return { version, distTag: 'latest', stamp: false };
  }

  if (compareCore(tagged.core, declared.core) !== 0) {
    throw new Error(`prerelease ${tag} is not a prerelease of package.json version ${packageVersion}; `
      + `tag v${declared.core.join('.')}-<id>, or change package.json's version first`);
  }
  return { version, distTag: 'next', stamp: version !== packageVersion };
}

module.exports = { plan };

if (require.main === module) {
  try {
    const result = plan(process.argv[2], require('../package.json').version, process.argv[3]);
    process.stdout.write(`version=${result.version}\ndist-tag=${result.distTag}\nstamp=${result.stamp}\n`);
  } catch (error) {
    process.stdout.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
