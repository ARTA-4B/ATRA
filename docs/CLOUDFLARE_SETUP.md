# Deploy ATRA to your new Cloudflare account

The frontend is prepared for **Workers Static Assets** in `wrangler.jsonc`. No account or domain is hardcoded. This deploys the public website and a clearly labeled dashboard preview. It does not deploy a wallet vault or trading runtime.

## Recommended: authenticate locally with your new account

1. Open Cloudflare in your browser. Sign out of the old account and sign in to the intended account.
2. Open PowerShell in `C:\ATRA` and run:

```powershell
cd C:\ATRA
npx wrangler logout
npx wrangler login
npx wrangler whoami
```

3. Approve the login in the browser. Check that `whoami` lists the intended account. OAuth credentials stay in Wrangler's local configuration; do not paste them into a conversation.
4. Give the assistant your chosen domain/subdomain and confirm the intended account. Account IDs and zone IDs are identifiers, not API secrets.
5. The assistant can then pin the account, validate the build, deploy, attach the custom domain, and check HTTPS.

If `CLOUDFLARE_API_TOKEN` is already set, Wrangler can use it instead of OAuth. Remove an obsolete environment token in your terminal before switching authentication methods. Do not print its value.

## Alternative: use an API token

1. In the intended Cloudflare account, open **My Profile → API Tokens → Create Token**. Use a custom token scoped to the intended account.
2. For a new Worker, grant the current **Workers Admin** role at the Workers product scope. Creating a new Worker requires this role. For subsequent deployments to an existing Worker, use **Editor** where supported.
3. To attach the domain, grant **Zone → Workers Routes → Write**, restricted to the intended zone, plus **Zone → Zone → Read** for lookup. Scope account-read access to the intended account as needed for account discovery. If using a legacy permissions UI, the Workers edit template may expose `Account → Workers Scripts → Edit`; follow the current Workers permission documentation for your account.
4. Do not grant billing or unrelated database/storage permissions. The static site does not need D1, KV, R2, or a global API key.
5. Set a suitable expiry. Save the token through a password prompt in PowerShell; do not paste it into chat or commit it:

```powershell
$atraToken = Read-Host 'Cloudflare API token' -AsSecureString
$atraCredential = New-Object System.Management.Automation.PSCredential('token', $atraToken)
[Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', $atraCredential.GetNetworkCredential().Password, 'User')
[Environment]::SetEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID', 'YOUR_ACCOUNT_ID', 'User')
Remove-Variable atraToken, atraCredential
```

Restart the Codex app so new processes inherit these user environment variables. The API token is stored in the Windows user environment; it is not an encrypted secret store. OAuth is preferable for interactive local setup. Never put the token into a `VITE_*` variable; those can be bundled into browser code.

## Domain prerequisites

Add the domain to the intended Cloudflare account. If the domain was registered elsewhere, update its nameservers at the registrar to the two nameservers Cloudflare assigns to that zone. Wait for the zone to become **Active**.

Do not remove existing mail records or overwrite an existing production website. An occupied hostname should be reviewed before attaching a Worker. Once the hostname is confirmed, add this to `wrangler.jsonc`:

```jsonc
"account_id": "YOUR_ACCOUNT_ID",
"routes": [
  { "pattern": "YOUR_DOMAIN", "custom_domain": true }
]
```

Cloudflare Custom Domains provisions the DNS connection and certificate. Keep the existing `assets` configuration. The assistant will replace placeholders only after the actual account and hostname are known.

## Validate and deploy

```powershell
npm run typecheck
npm run lint
npm test
npm run deploy:check
# After choosing the correct account and domain:
npm run deploy
```

`deploy:check` builds the project and performs a Wrangler dry run without publishing. `deploy` publishes to the configured Cloudflare account. No deployment has been performed solely by creating this guide.

## Official references

- [Wrangler authentication commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Current Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)
- [Workers Static Assets configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
