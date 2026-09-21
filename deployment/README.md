# kumudthakur.com.np/supervisorfinder

The Sites custom-domain control accepts a hostname, not a path. The existing domain is served by LiteSpeed, so keep its current DNS and upload `kumudthakur.com.np/supervisorfinder/index.html` into the hosting document root at `supervisorfinder/index.html`. This displays the account-backed Sites app at `https://kumudthakur.com.np/supervisorfinder/` without replacing the rest of the domain.

Check that the path returns 200 over HTTPS and that registration, sign-in, and profile analysis work inside the frame. The Sites app explicitly permits this domain as a frame ancestor and issues a partitioned session cookie for embedded sign-in. The `Open in a new tab` link provides direct access if a browser blocks embedded cookies.

No DNS change or Sites custom-domain attachment is required for this path. The wrapper itself stores no professor data or account credentials.
