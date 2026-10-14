# Security

An inventory of AWS IAM and the secret names in Infisical, judged into findings. **Level 5 never
receives a secret value or a credential**: only names and metadata. There is no Security section in
the app: critical and high findings show as one alert on Status, and new ones are notifications.

## How the inventory gets in

`status/scripts/security-inventory.mjs`, run where the `aws` and `infisical` CLIs are already logged
in (a laptop, or a routine), at the repo root:

```sh
node status/scripts/security-inventory.mjs            # sends to .claude/level5.json, or LEVEL5_URL + LEVEL5_KEY
node status/scripts/security-inventory.mjs --dry      # prints the payload, sends nothing
  --infisical-project <id>   # default: .infisical.json in the current directory
  --envs prod,staging        # default: prod,staging,dev (missing ones are skipped)
```

- **AWS IAM**: the credential report (users, console, MFA, access key age and last use, the root
  account), each user's policies and groups, and every role with who it trusts, its attached
  policies and when it was last used.
- **Infisical**: for each environment and folder, the list of secret **names**. The export is
  reduced to names before anything is built; the values never leave the process.
- Before sending, the payload is checked for anything that looks like a credential (AWS keys,
  private keys, API tokens, connection strings with a password) and refused if it finds one.

`POST /api/inventory` (the repo's ingest key) stores one inventory per kind, replacing the previous
one. The server keeps only known fields, length-limited, and secret names that look like names.

## Findings

| Severity | When |
| --- | --- |
| Critical | the root account has access keys, or no MFA; a role anyone (`*`) can assume |
| High | a user signs in to the console without MFA |
| Medium | an access key older than 90 days, or unused for 90 days; a role with AdministratorAccess |
| Low | a user with AdministratorAccess; a role unused for 90 days; secrets copied into 3 or more folders; keys in prod missing from staging |

New critical or high findings are notifications.
