# Releasing nightscout-connect

A release is a version tag. Pushing a `v*` tag runs
[`publish.yml`](../.github/workflows/publish.yml), which decides what the tag
publishes ([`scripts/release-version.js`](../scripts/release-version.js)),
runs the tests, waits for approval on the `npm-publish` environment, and
publishes to npm with a provenance attestation. No npm token exists for
this package; npm trusts the workflow directly.

There are two kinds of tag.

`package.json` on `dev` declares the version being worked on, for example
`0.1.0`. That one version is what both kinds of tag are measured against:

| | prerelease | full release |
|---|---|---|
| tag, when `package.json` says `0.1.0` | `v0.1.0-dev.1`, `v0.1.0-rc.1`, ... | `v0.1.0` |
| refused, when `package.json` says `0.1.0` | `v0.0.16-dev.1`, `v0.1.1-dev.1`, `v0.2.0-dev.1` | anything but `v0.1.0` |
| commit | `dev` as it stands | `main`, after `dev` is merged into it |
| npm dist-tag | `next` | `latest` |
| who gets it | only people who ask for it: `nightscout-connect@next` or an exact pin | `npm install nightscout-connect` |

npm publishes whatever version `package.json` holds, so for a prerelease the
workflow sets `0.1.0-dev.1` in its own checkout before testing and
publishing. Nothing is committed; the provenance attestation records the exact
commit the package was built from.

## Starting a new version

Open a pull request into `dev` that sets the next version
(`npm version 0.2.0 --no-git-tag-version` updates `package.json` and
`package-lock.json`), and merge it. From then on, `dev` can be tagged
`v0.2.0-dev.N` for prereleases, and `main` is tagged `v0.2.0` once `dev` is
merged into it. Do this right after a full release, so `dev` never declares a
version that is already published.

## A prerelease from dev

```sh
git fetch origin
git tag -a v0.1.0-dev.1 -m "nightscout-connect 0.1.0-dev.1" origin/dev
git push origin v0.1.0-dev.1
```

Then approve the `publish` job in the Actions tab. For the next one, tag
`v0.1.0-dev.2`, and so on.

## A full release

1. Make sure `package.json` on `dev` says the version you are releasing.
2. Merge `dev` into `main` through a pull request, with a merge commit. Do not
   squash or rebase: both rewrite the commits, so `main` stops sharing history
   with `dev` and every later `dev` to `main` pull request diverges.
3. Tag `main` and push the tag:

   ```sh
   git fetch origin
   git show origin/main:package.json | grep '"version"'
   git tag -a v0.1.0 -m "nightscout-connect 0.1.0" origin/main
   git push origin v0.1.0
   ```

4. Approve the `publish` job in the Actions tab.
5. Start the next version (above).

If the workflow refuses the tag, `main` already declares a version that npm
does not have. Fix the cause on `dev`, merge it into `main` again, delete the
refused tag (below) and tag the new `main`. Nothing was published, so the
version number is still available.

## What the workflow refuses

- a tag that is not `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-PRERELEASE`
  (build metadata such as `+build.1` is not accepted);
- a full release whose tag does not match the `package.json` version;
- a prerelease that is not a prerelease of the `package.json` version;
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
