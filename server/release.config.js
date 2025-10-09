import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default {
  branches: [
    "main",
     { name: "fix/changelog", prerelease: "changelog" },

    {
      name: "release-*",
      prerelease: true
    },
  ],
  plugins: [
    "@semantic-release/commit-analyzer", // decides bump (major/minor/patch)
    "@semantic-release/release-notes-generator", // generates human-readable notes
    [
      "@semantic-release/changelog", // writes to CHANGELOG.md
      {
        changelogFile: path.resolve(__dirname, "../CHANGELOG.md"),
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
        assets: ["package.json",  path.resolve(__dirname, "../CHANGELOG.md"),], // commit changelog + version
        message: "chore(release): ${nextRelease.version} [skip ci] n\n${nextRelease.notes}",
      },
    ],
  ],
}
