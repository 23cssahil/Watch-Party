const crypto = require('crypto');

/**
 * Room codes use an alphabet with the easily-confused characters taken out
 * (0/O, 1/I/L), so a code read aloud or typed from a screenshot isn't ambiguous.
 * Lookups are case-insensitive.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * @param {number} length
 * @returns {string}
 */
function generateRoomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

/**
 * Normalises user input into the canonical room-code form.
 * @param {unknown} input
 * @returns {string}
 */
function normalizeRoomCode(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = { generateRoomCode, normalizeRoomCode, ALPHABET };
