# CoLogi automated testing policy

Apply these rules to CP11, CP12, and all future CoLogi development.

## Test execution

- Use terminal tools, automated API tests, and headless browser automation. Computer Use, desktop control, interactive Chrome, and headed browser tests are prohibited, including as fallbacks.
- Do not control the Manager's mouse, keyboard, windows, browser, or applications. Do not use the Manager's browser profile, cookies, or sessions or close their applications.
- Run backend tests through pytest, Django TestCase, or APIClient on a dedicated PostgreSQL test database. Verify the database identity before each write-capable test invocation. Never run write tests against `cologi`.
- Use only authorized read requests for live API verification. Use authorized test accounts on the test database and do not reset existing users' passwords for verification. Record `NOT_VERIFIED` and assign Manual UAT when live credentials are unavailable or the check requires the Manager's interaction.
- Use Playwright with `headless: true`, a separate BrowserContext per role, desktop viewport 1440 × 1000, and mobile viewport 390 × 844. Capture screenshots, browser console errors, network errors, and a trace when a test fails.
- Store test evidence under `artifacts/`.

## Data and deployment

- Check the `cologi` schema and Dataset V7/Supplement before implementing features. Disclose any missing operational data. Report Technical Test PASS and Live Business Acceptance PASS separately.
- Keep the live target on PostgreSQL `cologi`, backend port 8014, and frontend port 5173. Only restart or modify services within the approved deployment scope.
- After an approved deployment, run HTTP/API smoke checks and Playwright headless tests. Record exactly which checks need Manual UAT and why.
