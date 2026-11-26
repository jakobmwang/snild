// @ts-check
/** Every piece of text the interface shows, in one place, so the interface can be translated. */
export const text = Object.freeze({
  appName: "snild",
  serverUnreachable: "snild cannot reach its server. Check that it is running, then reload this page.",
  /** @param {string | undefined} code */
  serverError: (code) => `The snild server answered with an error${code ? ` (${code})` : ""}. `
    + "Reload the page; if it persists, check the server's log.",
  reload: "Reload",

  // Banners and notes
  emulatorBanner: "Test mode: the test model plays scripted answers. No real model is used.",
  noModelTitle: "No model yet",
  noModelBody: "This version can only use the test model: start snild with SNILD_ENABLE_EMULATOR=1. "
    + "Connections to model APIs arrive in a later version.",

  // Setting up and signing in
  setupTitle: "Set up snild",
  setupIntro: "Create the first admin account with the one-time setup code from snild's log.",
  setupCode: "Setup code",
  username: "Username",
  usernameHint: "Letters a-z, digits, dot, dash or underscore.",
  displayName: "Your name (optional)",
  password: "Password",
  passwordHint: "At least 15 characters. A few words in a row work well.",
  repeatPassword: "Password again",
  passwordsDiffer: "The two passwords are not the same.",
  createAdmin: "Create admin account",
  signInTitle: "Sign in to snild",
  signIn: "Sign in",
  signedOutNotice: "You were signed out. Sign in to carry on where you were.",
  /** @param {number} seconds */
  tryAgainIn: (seconds) => `Too many attempts. Try again in ${seconds < 90 ? "a minute" : `${Math.round(seconds / 60)} minutes`}.`,

  // The rail
  chats: "Chats",
  newChat: "New chat",
  noChats: "Your chats will appear here.",
  periodToday: "Today",
  periodYesterday: "Yesterday",
  periodWeek: "Previous 7 days",
  periodOlder: "Older",
  untitled: "New chat",
  chatActions: "Chat actions",
  rename: "Rename",
  renameLabel: "New name for the chat",
  delete: "Delete",
  deleteTitle: "Delete this chat?",
  /** @param {string} title */
  deleteBody: (title) => `“${title}” and everything in it will be gone for good.`,
  deleteStopFirst: "A reply is still being written. Stop it first, then delete the chat.",
  cancel: "Cancel",

  // Account
  changePassword: "Change password",
  currentPassword: "Current password",
  newPassword: "New password",
  passwordChanged: "Password changed. You were signed out on every other device.",
  save: "Save",
  signOut: "Sign out",

  // The admin area
  admin: "Admin",
  adminTitle: "Admin",
  backToChat: "Back to chat",
  adminOnly: "Only admins can open the admin pages.",
  loading: "Loading…",
  loadFailed: "This could not be loaded.",
  tryAgain: "Try again",

  // Settings (admins)
  settingsTitle: "Settings",
  signInGroup: "Sign-in",
  chatsKept: "Chats are kept until people delete them.",
  noLimit: "No limit",
  unsaved: "You have unsaved changes.",
  discard: "Discard",
  settingsSaved: "Settings saved.",

  // People (admins)
  peopleTitle: "People",
  searchPeople: "Search people",
  noMatches: "Nobody matches that search.",
  addPerson: "Add person",
  addPersonBody: "Choose a password for them, and tell them what it is. They can change it in the account menu.",
  newName: "Name (optional)",
  makeAdminToo: "Admin: can manage people and settings",
  add: "Add",
  ok: "OK",
  roleAdmin: "Admin",
  statusDisabled: "Disabled",
  thisIsYou: "You",
  personActions: "Actions for",
  setPassword: "Set password",
  /** @param {string} name */
  setPasswordFor: (name) => `A new password for ${name}`,
  setPasswordBody: "Their old password stops working and they are signed out everywhere. Tell them the new one.",
  /** @param {string} name */
  personAdded: (name) => `${name} was added.`,
  /** @param {string} name */
  passwordSet: (name) => `${name} has a new password.`,
  makeAdmin: "Make admin",
  removeAdmin: "Remove admin",
  disable: "Disable",
  enable: "Enable",
  /** @param {string} name */
  confirmDisable: (name) => `Disable ${name}? They are signed out everywhere and cannot sign in until enabled.`,
  /** @param {string} name */
  confirmMakeAdmin: (name) => `Make ${name} an admin? They can then manage everyone, you included, from the next `
    + "time they open snild.",
  /** @param {string} name */
  confirmRemoveAdmin: (name) => `Remove ${name}'s admin rights?`,

  // The chat
  model: "Model",
  emptyTitle: "What can I help with?",
  emptyLead: "Ask anything. The test model plays scripted answers, so these show what snild can do:",
  starters: [
    { label: "A formatted answer", prompt: "Show me some markdown" },
    { label: "Think it through first", prompt: "Which is larger, 0.9 or 0.11? Think it through." },
    { label: "Analyse data with code", prompt: "Analyse the demo sales data" },
  ],
  jumpToLatest: "Jump to latest",
  copyAnswer: "Copy answer",
  /** @param {number} seconds */
  thoughtFor: (seconds) => `Thought for ${seconds} s`,
  thought: "Thought",
  toggleRail: "Show or hide the chat list",
  /** @type {Record<"system" | "light" | "dark", string>} */
  themeNames: { system: "System theme", light: "Light theme", dark: "Dark theme" },
  messagePlaceholder: "Message snild",
  messageLabel: "Message",
  send: "Send",
  stop: "Stop",
  stopping: "Stopping…",
  you: "You",
  assistant: "snild",
  thinkingNow: "Thinking…",
  /** What a tool is called on its card. @type {Record<string, string>} */
  toolNames: { run_js: "JavaScript" },
  /** @param {string} name */
  toolWriting: (name) => `Writing ${name}…`,
  /** @param {string} name */
  toolQueued: (name) => `Waiting to run ${name}…`,
  /** @param {string} name */
  toolRunning: (name) => `Running ${name}…`,
  /** @param {string} name @param {number | undefined} seconds */
  toolRan: (name, seconds) => (seconds === undefined ? `Ran ${name}`
    : `Ran ${name} · ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`),
  /** @param {string} name */
  toolFailed: (name) => `${name} failed`,
  toolStopped: "Stopped",
  /** @param {string} name */
  toolNotRun: (name) => `${name} has not run yet`,
  /** @param {string} name */
  toolDidNotRun: (name) => `${name} did not run`,
  toolCode: "Code",
  toolValue: "Returned",
  toolConsole: "Console",
  toolError: "Error",
  toolNote: "Note",
  chartAlt: "Chart drawn by the code",
  stopped: "Stopped.",
  table: "Table",
  copy: "Copy",
  copied: "Copied",
  /** @param {string} alt */
  imageLink: (alt) => `Image: ${alt || "untitled"}`,
  answerReady: "The answer is ready.",
  answerStopped: "The answer was stopped.",
  writing: "snild is writing…",

  // What went wrong, and the way forward
  interrupted: "The reply was cut off before it finished.",
  stoppedEarly: "Stopped before an answer was written.",
  unfinished: "The answer is not finished.",
  toolsStopped: "Stopped while the code ran. Continue runs it again, or write something new.",
  toolsWaiting: "The code in this answer has not run yet.",
  signOutFailed: "Could not sign out: snild cannot be reached. Try again.",
  renameFailed: "The chat could not be renamed. Try again.",
  continue: "Continue",
  retry: "Try again",
  conflict: "This chat changed in another tab. It now shows what was saved; your message is still here.",
  notSent: "Your message may not have reached snild: the connection dropped. It is still here; send it again. "
    + "If it did arrive, it will not be saved twice.",
  lost: "The connection to snild was lost. Check your network, then reload.",
  reconnecting: "Reconnecting to snild…",
  /** @param {string} code */
  failed: (code) => ({
    rate_limit: "The model is busy right now.",
    context_length: "This chat has grown too long for the model. Start a new chat to carry on.",
    unavailable: "The model could not be reached.",
    auth: "snild could not sign in to the model. Ask whoever runs snild to check its key.",
    timeout: "The model stopped answering.",
    bad_response: "The model sent a reply snild could not use.",
    internal: "Something went wrong on the server.",
    not_found: "This chat no longer exists.",
  })[code] || "Something went wrong.",
});
