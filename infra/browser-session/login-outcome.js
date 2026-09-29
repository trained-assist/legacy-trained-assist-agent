'use strict';
// Pure decision for login.js: given what the page looks like after submit, did the
// login succeed? Kept free of Playwright so it is unit-tested (test/browser-login-outcome.test.cjs).
//
// Bug it fixes (#1866): error text used to be ignored whenever the URL changed
// (`hasError = errorText && !navigated`). Keycloak-style forms re-POST to a new URL
// (…/login-actions/authenticate?…) on a REJECTED password, so "navigated" was true,
// the error was suppressed and the tool reported «Успешно залогинился».
// Rule now: an error message counts whenever we are still on a login form
// (password field visible, or a login-like URL) — URL change alone proves nothing.

const LOGIN_URL_RE = /login|signin|sign-in|auth/i;
const ERROR_RE = /неверн|invalid|incorrect|wrong|error|ошибк/i;
const TWO_FA_RE = /код|code|otp|two.factor|2fa|подтверд/i;

function isLoginLikeUrl(url) {
  return LOGIN_URL_RE.test(String(url || ''));
}

function decideLoginOutcome({
  urlBefore = '', urlAfter = '', titleBefore = '', titleAfter = '',
  pageText = '', hasCaptcha = false, passwordFieldVisible = false,
} = {}) {
  const urlChanged = urlAfter !== urlBefore;
  const titleChanged = titleAfter !== titleBefore && !/login|signin|вход/i.test(titleAfter);
  const navigated = urlChanged || titleChanged;

  // Still looking at a login form: the password input is on screen, or we never left
  // a login-like URL. A dashboard mentioning "error" somewhere is not a failed login.
  const stillOnLoginForm = passwordFieldVisible || isLoginLikeUrl(urlAfter);
  const hasError = ERROR_RE.test(pageText) && stillOnLoginForm;
  const has2fa = TWO_FA_RE.test(pageText) && !passwordFieldVisible && isLoginLikeUrl(urlAfter) && !hasError;

  // Success needs positive evidence: the password form is gone (SPAs may keep the URL)
  // and no error/captcha/2FA wall is in front of us.
  const ok = !hasError && !hasCaptcha && !has2fa && !passwordFieldVisible;

  return { ok, navigated, error_on_page: hasError, captcha: !!hasCaptcha, two_factor: has2fa };
}

module.exports = { decideLoginOutcome, isLoginLikeUrl };
