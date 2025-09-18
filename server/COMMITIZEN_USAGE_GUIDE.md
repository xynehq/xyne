# Commitizen Usage Guide for Xyne Project

## Overview

This guide explains how to use Commitizen in the Xyne project for creating standardized, conventional commit messages. The project uses Commitizen with commitlint and Husky hooks to ensure consistent commit formatting and automated release management.

## Table of Contents

1. [What is Commitizen?](#what-is-commitizen)
2. [Project Setup](#project-setup)
3. [How to Make Commits](#how-to-make-commits)
4. [Commit Message Format](#commit-message-format)
5. [Examples](#examples)
6. [Troubleshooting](#troubleshooting)
7. [Best Practices](#best-practices)

## What is Commitizen?

Commitizen is a tool that helps you write consistent commit messages by providing an interactive prompt. It ensures your commits follow the [Conventional Commits](https://www.conventionalcommits.org/) specification, which enables:

- **Automated versioning** using semantic-release
- **Automatic changelog generation**
- **Better project history** and collaboration
- **Automated release notes**

## Project Setup

The Xyne project has been configured with:

- **Commitizen**: Interactive commit message creation
- **Commitlint**: Validates commit messages against conventional commit rules
- **Husky**: Git hooks for automation
- **Semantic Release**: Automated versioning and releases

### Dependencies Installed

```json
{
  "devDependencies": {
    "@commitlint/cli": "^19.8.1",
    "@commitlint/config-conventional": "^19.8.1",
    "cz-conventional-changelog": "^3.3.0",
    "cz-customizable": "^7.5.1",
    "husky": "^9.1.7"
  }
}
```

### Git Hooks Configuration

- **`.husky/prepare-commit-msg`**: Automatically launches Commitizen when you commit
- **`.husky/commit-msg`**: Validates your commit message format

## How to Make Commits

### Method 1: Automatic (Recommended)

When you make a commit, Commitizen will automatically launch due to the Husky hook:

```bash
# Stage your changes
git add .

# Start commit process (Commitizen will launch automatically)
git commit
```

## Commit Message Format

Commitizen follows the Conventional Commits specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

| Type | Description | Example |
|------|-------------|---------|
| `feat` | New feature | `feat: add user dashboard` |
| `fix` | Bug fix | `fix: resolve login timeout issue` |
| `docs` | Documentation changes | `docs: update API documentation` |
| `style` | Code style changes (formatting, etc.) | `style: fix indentation in auth module` |
| `refactor` | Code refactoring | `refactor: simplify user validation logic` |
| `perf` | Performance improvements | `perf: optimize database queries` |
| `test` | Adding or updating tests | `test: add unit tests for auth service` |
| `chore` | Maintenance tasks | `chore: update dependencies` |
| `ci` | CI/CD changes | `ci: add automated testing workflow` |
| `build` | Build system changes | `build: update webpack configuration` |
| `revert` | Revert previous commit | `revert: undo user dashboard changes` |

### Scopes (Optional)

Scopes provide additional context about what part of the codebase is affected:

- `auth` - Authentication related
- `api` - API changes
- `ui` - User interface
- `db` - Database related
- `config` - Configuration changes
- `deps` - Dependencies

### Breaking Changes

For breaking changes, add `!` after the type or include `BREAKING CHANGE:` in the footer:

```
feat!: remove deprecated user API endpoints

BREAKING CHANGE: The old user API endpoints have been removed. Use the new v2 endpoints instead.
```

## Examples

### Interactive Commitizen Session

When you run `git commit`, you'll see prompts like this:

```
? Select the type of change that you're committing: (Use arrow keys)
❯ feat:     A new feature
  fix:      A bug fix
  docs:     Documentation only changes
  style:    Changes that do not affect the meaning of the code
  refactor: A code change that neither fixes a bug nor adds a feature
  perf:     A code change that improves performance
  test:     Adding missing tests or correcting existing tests
(Move up and down to reveal more choices)

? What is the scope of this change (e.g. component or file name): (press enter to skip)
 auth

? Write a short, imperative tense description of the change (max 94 chars):
 add two-factor authentication support

? Provide a longer description of the change: (press enter to skip)
 Implement TOTP-based two-factor authentication for enhanced security

? Are there any breaking changes? No

? Does this change affect any open issues? No
```

### Example Commit Messages

**Feature Addition:**
```
feat(auth): add two-factor authentication support

Implement TOTP-based two-factor authentication for enhanced security.
Users can now enable 2FA in their account settings.
```

**Bug Fix:**
```
fix(api): resolve timeout issues in user data fetch

- Increase timeout from 5s to 30s
- Add retry logic for failed requests
- Improve error handling

Fixes #123
```

**Documentation:**
```
docs: update installation guide with new requirements

Add instructions for setting up the development environment
with the latest Node.js version and updated dependencies.
```

**Breaking Change:**
```
feat(api)!: update user authentication endpoints

BREAKING CHANGE: The authentication endpoints have been updated.
- /auth/login is now /api/v2/auth/login
- /auth/logout is now /api/v2/auth/logout

Migration guide available in docs/migration.md
```

## Troubleshooting

### Common Issues

#### 1. Commitizen doesn't launch automatically

**Problem**: Git commit doesn't trigger Commitizen

**Solution**: 
```bash
# Check if Husky is installed
cd server
bun install

# Verify Husky hooks
ls -la .husky/
```

#### 2. Commit message validation fails

**Problem**: `commitlint` rejects your commit message

**Solution**: Ensure your message follows the conventional format:
- Start with a valid type (`feat`, `fix`, etc.)
- Use lowercase for the type
- Include a colon and space after the type
- Keep the subject line under 100 characters

#### 3. "CZ_SKIP_HOOK" environment variable

**Problem**: Commitizen runs in an infinite loop

**Solution**: The project already handles this with the `CZ_SKIP_HOOK` variable in the Husky hook.

#### 4. Working directory issues

**Problem**: Commitizen can't find configuration

**Solution**: Ensure you're in the project root and the server directory exists:
```bash
# The Husky hook automatically changes to the server directory
cd server
bunx cz
```

### Manual Override

If you need to bypass Commitizen temporarily:

```bash
# Skip the prepare-commit-msg hook
git commit -m "your message" --no-verify
```

**Note**: This bypasses both Commitizen and commitlint validation.

## Best Practices

### 1. Write Clear Descriptions

- Use imperative mood ("add" not "added" or "adds")
- Start with a lowercase letter after the colon
- Be specific but concise
- Explain what and why, not how

**Good:**
```
feat(auth): add password strength validation
```

**Bad:**
```
feat: added some stuff for passwords
```

### 2. Use Appropriate Types

- `feat`: Only for new features visible to users
- `fix`: Only for actual bug fixes
- `chore`: For maintenance tasks that don't affect users

### 3. Include Context in Body

For complex changes, use the body to explain:
- Why the change was made
- What alternatives were considered
- Any side effects or considerations

### 4. Reference Issues

Link commits to issues when applicable:
```
fix(api): resolve memory leak in data processing

The previous implementation didn't properly clean up event listeners,
causing memory usage to grow over time.

Fixes #456
Closes #789
```

### 5. Atomic Commits

Make each commit represent a single logical change:
- One feature per commit
- One bug fix per commit
- Don't mix refactoring with feature additions

### 6. Test Before Committing

Always test your changes before committing:
```bash
# Run tests
bun test

# Stage changes
git add .

# Commit with Commitizen
git commit
```

## Integration with Semantic Release

Your commits directly affect versioning:

- `fix`: Patch version (1.0.1)
- `feat`: Minor version (1.1.0)
- `feat!` or `BREAKING CHANGE`: Major version (2.0.0)

### Version Impact Examples

```bash
# These commits would result in version 1.2.3 → 1.2.4
fix(auth): resolve login timeout
fix(ui): correct button alignment

# These commits would result in version 1.2.3 → 1.3.0
feat(dashboard): add user analytics
feat(api): implement data export

# This commit would result in version 1.2.3 → 2.0.0
feat(api)!: redesign authentication system
```

## Configuration Files

### Commitlint Configuration (`server/commitlint.config.js`)

```javascript
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0], // disable subject case rule
  },
};
```

### Package.json Configuration

```json
{
  "config": {
    "commitizen": {
      "path": "./server/cz-adapter.js"
    }
  }
}
```

## Getting Help

If you encounter issues:

1. **Check the commit format** against the examples above
2. **Review the error message** from commitlint
3. **Try running Commitizen manually**: `cd server && bunx cz`
4. **Check project documentation** for any project-specific rules
5. **Ask the team** for guidance on commit message conventions

## Summary

Using Commitizen in the Xyne project ensures:
- ✅ Consistent commit message format
- ✅ Automated version management
- ✅ Generated changelogs
- ✅ Better collaboration and project history
- ✅ Automated releases

Remember: Good commit messages are a gift to your future self and your teammates!
