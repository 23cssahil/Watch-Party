/**
 * Text hygiene for anything a user types that other users will see.
 * Kept tiny and dependency-free on purpose: this is a username and a chat box,
 * not a rich-text editor.
 */

/** Strip ASCII control characters and collapse whitespace runs. */
function cleanText(input, maxLength) {
  if (typeof input !== 'string') return '';
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // Remove angle brackets so a username can't be mistaken for HTML by anything
    // that renders it later.
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * @param {unknown} username
 * @returns {string} 1..24 chars, guaranteed non-empty by the caller's fallback
 */
function sanitizeUsername(username) {
  return cleanText(username, 24);
}

/** @param {unknown} text @returns {string} */
function sanitizeChat(text) {
  return cleanText(text, 500);
}

/** @param {unknown} emoji @returns {string} */
function sanitizeReaction(emoji) {
  return cleanText(emoji, 8);
}

/**
 * A video title, i.e. text a client read off the YouTube player and sent to us.
 * Same cleaning as chat, for the same reason: it gets shown next to other
 * people's names and saved in the database.
 * @param {unknown} title @returns {string}
 */
function sanitizeTitle(title) {
  return cleanText(title, 200);
}

module.exports = { sanitizeUsername, sanitizeChat, sanitizeReaction, sanitizeTitle };
