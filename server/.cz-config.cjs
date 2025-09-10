module.exports = {
  types: [
    { value: "feat", name: "feat:     A new feature" },
    { value: "fix", name: "fix:      A bug fix" },
    { value: "docs", name: "docs:     Documentation only changes" },
    { value: "style", name: "style:    Code style changes (formatting, etc)" },
    { value: "refactor", name: "refactor: A code change that neither fixes a bug nor adds a feature" },
    { value: "test", name: "test:     Adding missing tests" },
    { value: "chore", name: "chore:    Build process or auxiliary tool changes" }
  ],

  scopes: [],

  messages: {
    type: "Select the type of change that you're committing:",
    scope: "What is the scope of this change (e.g. component or file name):",
    subject: "Write a short, imperative description of the change:",
    body: "Provide a longer description of the change (optional):",
    breaking: "Are there any breaking changes?",
    footer: "List any issues closed by this change (optional):",
    confirmCommit: "Are you sure you want to proceed with the commit above?"
  },

  allowCustomScopes: false,
  allowBreakingChanges: ["feat", "fix"],
  skipQuestions: ["body", "footer"],
  subjectLimit: 90,

  // Add custom questions for Linear ticket
  additionalQuestions: [
    {
      name: 'ticket',
      message: 'Enter the Linear ticket ID (e.g. XYN-123, or leave empty):',
      optional: true
    }
  ],

  // Custom format function that includes the ticket
  formatCommitMessage: function(answers) {
    const { type, scope, subject, ticket } = answers;
    const scopeStr = scope ? `(${scope})` : "";
    const ticketStr = ticket ? ` [${ticket}]` : "";
    return `${type}${scopeStr}: ${subject}${ticketStr}`;
  }
};
