# TeleSculpt Infrastructure

Everything Azure-related lives here. Two PowerShell scripts (usable locally or
from CI) plus three GitHub Actions workflows in `/.github/workflows`.

## What gets created

| Resource | Name | Notes |
|---|---|---|
| Resource group | `rg-telesculpt` | Everything lives here — teardown deletes this group |
| Storage account | `sttelesculpt<suffix>` | Standard_LRS, StorageV2, TLS 1.2 min, public blob access allowed |
| Tables | `rooms`, `turns` | Game state |
| Blob container | `sculptures` | Public **blob** read; CORS allows `*` origins, GET/PUT/OPTIONS |
| Function app | `func-telesculpt-<suffix>` | Linux Consumption, Node 22, Functions v4, CORS `*` |

Region: `westus2` (default, overridable with `-Location`).

## Required GitHub secret

### `AZURE_CREDENTIALS`

Service principal JSON used by `azure/login@v2`. Create it with:

```sh
az ad sp create-for-rbac \
  --name telesculpt-deploy \
  --role Contributor \
  --scopes /subscriptions/<your-subscription-id> \
  --sdk-auth
```

Paste the entire JSON output (the object with `clientId`, `clientSecret`,
`subscriptionId`, `tenantId`) into a repo secret named `AZURE_CREDENTIALS`
(**Settings → Secrets and variables → Actions → New repository secret**).

> `--sdk-auth` is deprecated in newer az versions but still works and is the
> format `azure/login` expects for the `creds` input.

## Required GitHub repo variables

Set under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Example | Used by |
|---|---|---|
| `RESOURCE_SUFFIX` | `sunny42` | `spin-up.yml` — default suffix when the dispatch input is left blank. Lowercase letters/digits only, ≤14 chars (storage account name limits). |
| `API_BASE_URL` | `https://func-telesculpt-sunny42.azurewebsites.net` | `pages.yml` — injected into `docs/js/config.js` (replaces `PLACEHOLDER_PROD_API`; the frontend appends `/api` itself, so do NOT include the path). |

## Workflows

### Spin up (`spin-up.yml`)

**Actions → Spin Up → Run workflow.** Optionally type a suffix; blank uses
`RESOURCE_SUFFIX`. It logs into Azure, runs `provision.ps1`, then deploys
`/api` to the Function app via `Azure/functions-action@v1` (remote Oryx build
installs dependencies — `provision.ps1` sets
`SCM_DO_BUILD_DURING_DEPLOYMENT=true`). The final step prints the Function app
URL — copy it (host only, no `/api`) into the `API_BASE_URL` variable, then re-run the
Pages deploy if needed.

### Spin down (`spin-down.yml`)

**Actions → Spin Down → Run workflow** and type `DELETE` (exactly) into the
confirm box. Anything else fails the run before touching Azure. Deletes the
entire `rg-telesculpt` resource group.

### Pages (`pages.yml`)

Runs on pushes to `main` touching `docs/**`, or manually. Copies `/docs` to a
staging directory, swaps `PLACEHOLDER_PROD_API` in `js/config.js` for
`API_BASE_URL`, and publishes via the official
`upload-pages-artifact`/`deploy-pages` actions. One-time setup: repo
**Settings → Pages → Source: GitHub Actions**.

## Local provisioning

```powershell
az login
./infra/provision.ps1 -Suffix sunny42            # westus2 by default
./infra/provision.ps1 -Suffix sunny42 -Location westus3
```

The script is idempotent — re-run it freely. It prints the Function app URL
when finished.

Teardown (typed confirmation required):

```powershell
./infra/teardown.ps1 -Confirm DELETE
```

It lists everything in `rg-telesculpt` before deleting the group. Any value
other than the exact string `DELETE` aborts.

## Cost

Effectively **$0/month** while running, $0 when spun down:

- Functions Consumption: first 1M executions/month free, forever
- Table Storage: pennies at party-game scale (first 1GB free for 12 months)
- Blob Storage: sculpture JSONs are a few KB each (first 5GB free for 12 months)
- GitHub Pages / Actions: free for public repos

Worst realistic case is ~$1–3/month. Spin down when you're not playing and it
costs nothing at all.
