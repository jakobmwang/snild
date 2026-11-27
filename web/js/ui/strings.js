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
  chatsKept: "Chats and their files are kept until people delete them.",
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
    { label: "Think it through first", prompt: "Which is larger, 0.9 or 0.11? Think it through." },
    { label: "Analyse data with code", prompt: "Analyse the demo sales data" },
    { label: "Check a PDF report", prompt: "Check the demo sales report against the data" },
    { label: "Make a report", prompt: "Make a report of the demo sales" },
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
  hiddenKept: (file, count) => `${file} contains hidden text${count === 1 ? "" : ` in ${count} places`}, `
    + "kept from the model: text no one sees on the page, which may hold instructions meant for it.",
  showHidden: "Show",
  hideHidden: "Hide",
  readingHidden: "Reading…",
  addHidden: "Add to message",
  hiddenTooLong: "That would make the message too long. Copy the part you need instead.",
  /** How a piece of text is hidden, from digpdf's data-hidden (several joined by +). @param {string} kind */
  hiddenKind: (kind) => kind.split("+").map((part) => ({ offpage: "off the page", clipped: "cut off",
    covered: "covered", invisible: "invisible", samecolour: "in the colour of the page", tiny: "too small to see" })[part]
    ?? part).join(", "),
  /** @param {{page: number | null, kind: string}} item */
  hiddenWhere: (item) => `${item.page ? `Page ${item.page}` : "Outside the pages"}, ${text.hiddenKind(item.kind)}`,
  /** @param {string} file @param {{page: number | null, kind: string, text: string}[]} items */
  hiddenQuote: (file, items) => [`Hidden text in ${file}, kept from the model until now:`,
    ...items.map((item) => `> ${text.hiddenWhere(item)}: ${item.text.replace(/\r\n|\r|\n/g, "\n> ")}`)].join("\n"),
  // Reports
  reportMade: "Made a report",
  reportFailed: "The report could not be made",
  reportMaking: "Making a report…",
  reportWriting: "Writing a report…",
  reportQueued: "Waiting to make a report…",
  reportNotMade: "The report has not been made yet",
  /** @param {string} file */
  reportFrom: (file) => `From the file ${file}`,
  reportSource: "HTML",
  reportRemoved: "Removed from the report",
  openReport: "Open report",
  closeReport: "Close report",
  reportOpening: "Opening the report…",
  reportTooLarge: "This report is larger than 5 MiB, the most a report may be.",
  reportGone: "This report is no longer in this chat.",
  reportListFailed: "The chat's files could not be read, so the report cannot be opened now. Try again.",

  // Files
  files: "Files",
  /** @param {number} count */
  filesButton: (count) => (count ? `Files (${count})` : "Files"),
  closeFiles: "Close files",
  noFiles: "No files here yet. Attach files with the paperclip, by pasting them, or by dropping them on the chat.",
  attachFiles: "Attach files",
  attachedFiles: "Attached files",
  /** @param {string} name */
  removeFile: (name) => `Remove ${name}`,
  uploading: "Uploading…",
  uploadFailed: "Could not upload.",
  sendWaits: "Send (waiting for files)",
  folderRefused: "A folder cannot be attached. Attach the files in it instead.",
  byYou: "You",
  byModel: "Model",
  download: "Download",
  /** @param {string} name */
  downloadFile: (name) => `Download ${name}`,
  /** @param {string} name */
  deleteFile: (name) => `Delete ${name}`,
  deleteFileTitle: "Delete this file?",
  /** @param {string} name */
  deleteFileBody: (name) => `“${name}” is removed from this chat. Messages that attached it keep its name and size.`,
  /** @param {number} bytes */
  size: (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MiB`),
  /** @param {number} seconds since 1970, as the server says */
  when: (seconds) => {
    const date = new Date(seconds * 1000);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString([], { day: "numeric", month: "short" });
  },
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
    unknown_files: "A file attached to the message is no longer in this chat. Remove it and send again.",
  })[code] || "Something went wrong.",
});
