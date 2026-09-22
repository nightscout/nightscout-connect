# Releasing nightscout-connect

A release is a version tag. Pushing a `v*` tag runs
[`publish.yml`](../.github/workflows/publish.yml), which decides what the tag
publishes ([`scripts/release-version.js`](../scripts/release-version.js)),
runs the tests, waits for approval on the `npm-publish` environment, and
publishes to npm with a provenance attestation. No npm token exists for
this package; npm trusts the workflow directly.

There are two kinds of tag.

| | prerelease | full release |
|---|---|---|
| tag | `v0.1.0-dev.1`, `v0.1.0-rc.1` | `v0.1.0` |
| commit | `dev` as it stands | a commit whose `package.json` says `0.1.0` |
| version bump | none: the workflow stamps the tag's version into `package.json` before testing and publishing | a pull request into `dev` first |
| npm dist-tag | `next` | `latest` |
| who gets it | only people who ask for it: `nightscout-connect@next` or an exact pin | `npm install nightscout-connect` |

## A prerelease from dev

```sh
git fetch origin
git tag -a v0.1.0-dev.1 -m "nightscout-connect 0.1.0-dev.1" origin/dev
git push origin v0.1.0-dev.1
```

Then approve the `publish` job in the Actions tab. For the next one, tag
`v0.1.0-dev.2`, and so on. The base version (`0.1.0`) must be `package.json`'s
version or later, and newer than npm's current `latest`.

The published `package.json` differs from the tagged commit in its `version`
field only; the provenance attestation records the exact commit it was built
from.

## A full release

1. Open a pull request into `dev` that sets the version
   (`npm version 0.1.0 --no-git-tag-version` updates `package.json` and
   `package-lock.json`), and merge it.
2. Tag that commit and push the tag:

   ```sh
   git fetch origin
   git tag -a v0.1.0 -m "nightscout-connect 0.1.0" origin/dev
   git push origin v0.1.0
   ```

3. Approve the `publish` job in the Actions tab.
4. Merge `dev` into `main`.

## What the workflow refuses

- a tag that is not `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-PRERELEASE`
  (build metadata such as `+build.1` is not accepted);
- a full release whose tag does not match the `package.json` version;
- a prerelease whose base version is older than the `package.json` version;
- any version at or below npm's current `latest`: a full release would move
  `latest` backwards, and a prerelease would sort below what users have;
- a tagged commit that is not on `dev` or `main`;
- a version already on npm (npm never allows a version to be reused, even
  after unpublishing; a bad `dev.1` is followed by `dev.2`);
- failing tests.

A refused tag publishes nothing. Delete it (`git push origin :refs/tags/vX`)
and push a corrected one.

## One-time setup

These settings live outside the repository and must be in place before the
first tag is pushed. The workflow cannot publish without the first two.

### On npmjs.com (a package owner)

1. **Package → Settings → Trusted publishing → GitHub Actions:**
   - Organization or user: `nightscout`
   - Repository: `nightscout-connect`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish`
2. **Package → Settings → Publishing access:** choose *Require two-factor
   authentication and disallow tokens*. Trusted publishing keeps working;
   stolen or leaked tokens cannot publish.
3. Revoke any existing automation or publish tokens for this package.
4. Add a second owner, so publishing access does not depend on one account.

### On GitHub (a repository admin)

1. **Settings → Environments → New environment `npm-publish`:**
   - Required reviewers: the people who may approve a release.
   - Deployment branches and tags: *Selected*, tag pattern `v*`.
2. **Settings → Rules → Rulesets:** a tag ruleset on `v*` that restricts
   creation, update and deletion to maintainers, so a published version's
   tag cannot be moved afterwards.

## Using a release from cgm-remote-monitor

Pin the exact version, with no range, and commit the regenerated lockfile:

```json
"nightscout-connect": "0.0.15"
```

To try unreleased connector work on a cgm-remote-monitor branch, publish a
pre-release and pin that exact version, for example `0.0.15-dev.1`.
