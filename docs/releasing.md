# Releasing nightscout-connect

A release is a version tag. Pushing `vX.Y.Z` runs
[`publish.yml`](../.github/workflows/publish.yml), which checks the tag,
runs the tests, waits for approval on the `npm-publish` environment, and
publishes to npm with a provenance attestation. No npm token exists for
this package; npm trusts the workflow directly.

## Cutting a release

1. On `dev` (or `main`), set `version` in `package.json` and
   `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`), commit,
   and push the branch.
2. Tag that commit and push the tag:

   ```sh
   git tag -a vX.Y.Z -m "nightscout-connect X.Y.Z"
   git push origin vX.Y.Z
   ```

3. Approve the `publish` job in the Actions tab.

The workflow refuses to publish when:

- the tag is not `v` followed by the `package.json` version;
- the tagged commit is not on `dev` or `main`;
- that version is already on npm (npm never allows a version to be reused,
  even after unpublishing);
- the tests fail.

A version with a pre-release suffix, such as `0.0.15-dev.1`, is published
under the `next` dist-tag, so `npm install nightscout-connect` keeps
resolving to the last full release. Anything else becomes `latest`.

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
