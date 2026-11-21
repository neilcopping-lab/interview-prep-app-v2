// The "check your spam" line that goes on every email we send to customers.
// One place, so the wording stays the same everywhere.
const SPAM_TEXT =
  "Not seeing our emails? Have a look in your spam or junk folder. If you find one of ours there, " +
  "press \"Not spam\" (or \"Not junk\" in Outlook) and the next ones will land straight in your inbox.";

const SPAM_HTML =
  '<p style="font-size:13px;line-height:1.5;color:#5B5F66;margin:16px 0 0">' +
  "<strong>Not seeing our emails?</strong> Have a look in your spam or junk folder. If you find one of ours there, " +
  "press &ldquo;Not spam&rdquo; (or &ldquo;Not junk&rdquo; in Outlook) and the next ones will land straight in your inbox.</p>";

const withSpamText = (text) => (text ? `${text}\n\n${SPAM_TEXT}` : text);

module.exports = { SPAM_TEXT, SPAM_HTML, withSpamText };
