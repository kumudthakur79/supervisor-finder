# Supervisor Fit Lab

PhD professor matcher with user accounts. Visitors can register with a username and password; each account has a separate workspace stored in the site's database. The browser stores only a session cookie. Existing locally saved workspaces can be imported after sign-in.

## Profile links

In Add professor, a signed-in user can paste a public HTTPS profile URL and choose Analyze profile link. The server reads HTML from the page, suggests the name, institution, research areas, and ratings from matched phrases, and displays the matched terms. Unclear criteria remain unknown. Suggestions are editable and saved only after the user reviews the form.

The analyzer enforces HTTPS, checks redirects, rejects local hosts and IP addresses, caps response size and duration, and limits per-account requests. Some faculty sites block automated reads or publish profiles without machine-readable text; the manual form remains available.

## Authentication

- Passwords use PBKDF2-SHA-256 with a unique 24-byte salt and 100,000 iterations (the hosting runtime's maximum).
- Sessions use random tokens in secure, HTTP-only, same-site cookies. Only token hashes are stored in D1.
- Workspace requests are account-scoped on the server. Mutations check the request origin and revision.
- Registration and login have basic server-side attempt limits.
- Password recovery is not implemented. Users should keep their password in a safe place.

Run `node tests/auth-test.mjs` and `node tests/interaction-test.mjs` to validate the account and matcher flows.

## Scoring

- AI alignment: 25%
- Cybersecurity alignment: 25%
- AI × cybersecurity: 35%
- Funding signal: 15%

Unknown criteria are excluded from the fit calculation. Evidence coverage is shown separately.
