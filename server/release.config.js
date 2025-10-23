// release.config.js
export default {
  branches: [
    "main",
    {
      name: "release-*",
      prerelease: true,
    },
  ],
  plugins: [
    "@semantic-release/commit-analyzer", // decides bump (major/minor/patch)
    "@semantic-release/release-notes-generator", // generates human-readable notes
    [
      "@semantic-release/changelog", // writes to CHANGELOG.md
      {
        changelogFile: "CHANGELOG.md",
      },
    ],
    [
      "@semantic-release/npm",
      {
        npmPublish: false, // no npm publish
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md"], // commit changelog + version
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
}
