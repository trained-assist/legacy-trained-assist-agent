'use strict';
// #1866: login.js reported «Успешно залогинился» on rejected credentials because error
// text was ignored whenever the URL changed (Keycloak re-POSTs to a new URL on failure).
const { decideLoginOutcome, isLoginLikeUrl } = require('../infra/browser-session/login-outcome.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? (pass++) : (fail++, console.log('FAIL:', m)); }

// 1. Keycloak rejection (the Contabo case): URL changed, error text, password field still there.
let r = decideLoginOutcome({
  urlBefore: 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/auth?client_id=x',
  urlAfter: 'https://auth.contabo.com/auth/realms/contabo/login-actions/authenticate?session_code=y',
  titleBefore: 'Sign in to contabo', titleAfter: 'Sign in to contabo',
  pageText: 'Sign in\nInvalid username or password.\nPassword', passwordFieldVisible: true,
});
ok(r.navigated === true, 'keycloak: URL changed → navigated');
ok(r.ok === false, 'keycloak: rejected creds must NOT be ok');
ok(r.error_on_page === true, 'keycloak: error surfaced despite navigation');

// 2. Russian error, no navigation.
r = decideLoginOutcome({ urlBefore: 'https://x.ru/login', urlAfter: 'https://x.ru/login', pageText: 'Неверный пароль', passwordFieldVisible: true });
ok(!r.ok && r.error_on_page, 'ru error, same url → failed');

// 3. Real success: left to dashboard; dashboard text mentions "error" (e.g. an "Error log" widget).
r = decideLoginOutcome({ urlBefore: 'https://x.ru/login', urlAfter: 'https://x.ru/dashboard', titleBefore: 'Вход', titleAfter: 'Панель', pageText: 'Error log: 0 entries', passwordFieldVisible: false });
ok(r.ok === true && r.error_on_page === false, 'success: dashboard "error" word is not a login error');

// 4. SPA success without URL/title change: password form gone.
r = decideLoginOutcome({ urlBefore: 'https://app.io/', urlAfter: 'https://app.io/', pageText: 'Welcome back', passwordFieldVisible: false });
ok(r.ok === true, 'spa: form gone, no error → ok');

// 5. Nothing happened: form still on screen, no error text → not ok (was ok before the fix).
r = decideLoginOutcome({ urlBefore: 'https://x.ru/login', urlAfter: 'https://x.ru/login', pageText: 'Email Пароль Войти', passwordFieldVisible: true });
ok(r.ok === false && r.error_on_page === false, 'form still there → not ok, no false error');

// 6. Captcha blocks success.
r = decideLoginOutcome({ urlBefore: 'https://x.ru/login', urlAfter: 'https://x.ru/home', pageText: 'ok', hasCaptcha: true });
ok(r.ok === false && r.captcha === true, 'captcha → not ok');

// 7. 2FA step: password field gone, OTP prompt on an auth URL.
r = decideLoginOutcome({ urlBefore: 'https://x.ru/login', urlAfter: 'https://x.ru/login/otp', pageText: 'Введите код из SMS', passwordFieldVisible: false });
ok(r.ok === false && r.two_factor === true && r.error_on_page === false, '2fa detected');

ok(isLoginLikeUrl('https://a/signin') && !isLoginLikeUrl('https://a/dashboard'), 'isLoginLikeUrl');

console.log(`browser-login-outcome: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
