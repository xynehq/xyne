// release.config.js
export default {
  branches: ['main'], // main branch
  plugins: [
    '@semantic-release/commit-analyzer', // analyzes commits for version bump
    [
      '@semantic-release/npm',           // updates package.json version
      {
        npmPublish: false                // don’t publish to npm
      }
    ],
  ]
};
