'use strict'

const fs = require('fs')
const path = require('path')
const glob = require('glob')
const publishRelease = require('publish-release')
const releaseNotes = require('./lib/release-notes')
const uploadToS3 = require('./lib/upload-to-s3')
const uploadLinuxPackages = require('./lib/upload-linux-packages')

const CONFIG = require('../config')

const yargs = require('yargs')
const argv = yargs
  .usage('Usage: $0 [options]')
  .help('help')
  .describe('assets-path', 'Path to the folder where all release assets are stored')
  .describe('s3-path', 'Indicates the S3 path in which the assets should be uploaded')
  .describe('create-github-release', 'Creates a GitHub release for this build, draft if release branch or public if Nightly')
  .describe('linux-repo-name', 'If specified, uploads Linux packages to the given repo name on packagecloud')
  .wrap(yargs.terminalWidth())
  .argv

const releaseVersion = CONFIG.computedAppVersion
const isNightlyRelease = CONFIG.channel === 'nightly'
const assetsPath = argv.assetsPath || CONFIG.buildOutputPath
const assetsPattern = '/**/*(*.exe|*.zip|*.nupkg|*.tar.gz|*.rpm|*.deb|RELEASES*|atom-api.json)'
const assets = glob.sync(assetsPattern, { root: assetsPath, nodir: true })
const bucketPath = argv.s3Path || `releases/v${releaseVersion}/`

if (!assets || assets.length === 0) {
  console.error(`No assets found under specified path: ${assetsPath}`)
  process.exit(1)
}

async function uploadArtifacts () {
  console.log(`Uploading ${assets.length} release assets for ${releaseVersion} to S3 under '${bucketPath}'`)

  await uploadToS3(
    process.env.ATOM_RELEASES_S3_KEY,
    process.env.ATOM_RELEASES_S3_SECRET,
    process.env.ATOM_RELEASES_S3_BUCKET,
    bucketPath,
    assets)

  if (argv.linuxRepoName) {
    await uploadLinuxPackages(
      argv.linuxRepoName,
      process.env.PACKAGE_CLOUD_API_KEY,
      releaseVersion,
      assets)
  } else {
    console.log('Skipping upload of Linux packages')
  }

  const oldReleaseNotes =
    await releaseNotes.get(
      releaseVersion,
      process.env.GITHUB_TOKEN)

  if (oldReleaseNotes) {
    const oldReleaseNotesPath = path.resolve(CONFIG.buildOutputPath, 'OLD_RELEASE_NOTES.md')
    console.log(`Saving existing ${releaseVersion} release notes to ${oldReleaseNotesPath}`)
    fs.writeFileSync(oldReleaseNotesPath, oldReleaseNotes, 'utf8')
  }

  if (argv.createGithubRelease) {
    console.log(`\nGenerating new release notes for ${releaseVersion}`)
    let newReleaseNotes = ''
    if (isNightlyRelease) {
      newReleaseNotes =
        await releaseNotes.generateForNightly(
          releaseVersion,
          process.env.GITHUB_TOKEN,
          oldReleaseNotes)
    } else {
      newReleaseNotes =
        await releaseNotes.generateForVersion(
          releaseVersion,
          process.env.GITHUB_TOKEN,
          oldReleaseNotes)
    }

    console.log(`New release notes:\n\n${newReleaseNotes}`)

    console.log(`Creating GitHub release v${releaseVersion}`)
    const release =
      await publishReleaseAsync({
        token: process.env.GITHUB_TOKEN,
        owner: 'atom',
        repo: !isNightlyRelease ? 'atom' : 'atom-nightly-releases',
        name: CONFIG.computedAppVersion,
        body: newReleaseNotes,
        tag: `v${CONFIG.computedAppVersion}`,
        draft: !isNightlyRelease,
        prerelease: CONFIG.channel !== 'stable',
        reuseRelease: true,
        skipIfPublished: true,
        assets
      })

    console.log('Release published successfully: ', release.html_url)
  } else {
    console.log('Skipping GitHub release creation')
  }
}

async function publishReleaseAsync (options) {
  return new Promise((resolve, reject) => {
    publishRelease(options, (err, release) => {
      if (err) {
        reject(err)
      } else {
        resolve(release)
      }
    })
  })
}

// Wrap the call the async function and catch errors from its promise because
// Node.js doesn't yet allow use of await at the script scope
uploadArtifacts().catch(err => {
  console.error('An error occurred while uploading the release:\n\n', err)
  process.exit(1)
})
