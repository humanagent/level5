#!/usr/bin/env node
// security-inventory.mjs: send Level 5 an inventory of AWS IAM and Infisical secret NAMES.
//
//   node security-inventory.mjs [--infisical-project <id>] [--envs prod,staging] [--dry]
//
// Uses the CLIs already logged in on this machine or in this job (aws, infisical). Level 5 gets no
// credentials. Secret VALUES never leave this process: the Infisical export is reduced to key names
// before anything is built, and the payload is checked for values before it is sent.
//
// Where to send: LEVEL5_URL and LEVEL5_KEY, or .claude/level5.json in the current repo.
// --dry prints the payload instead of sending it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes("--dry");
const run = (cmd, a, { quiet = true } = {}) => {
  try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", quiet ? "ignore" : "inherit"], maxBuffer: 64e6 }); }
  catch { return null; }
};
const aws = (...a) => { const o = run("aws", [...a, "--output", "json"]); return o ? JSON.parse(o) : null; };

// ---------- AWS IAM ----------
function iam() {
  const who = aws("sts", "get-caller-identity");
  if (!who) return null;
  // the credential report: one row per user (and the root account) with MFA, console and key ages
  aws("iam", "generate-credential-report");
  let rep = null;
  for (let i = 0; i < 10 && !rep; i++) { rep = aws("iam", "get-credential-report"); if (!rep) execFileSync("sleep", ["1"]); }
  const rows = [];
  if (rep?.Content) {
    const [head, ...lines] = Buffer.from(rep.Content, "base64").toString("utf8").trim().split("\n");
    const cols = head.split(",");
    for (const l of lines) { const v = l.split(","); rows.push(Object.fromEntries(cols.map((c, i) => [c, v[i]]))); }
  }
  const val = (x) => (!x || x === "N/A" || x === "no_information" || x === "not_supported" ? null : x);
  const yes = (x) => x === "true";
  const users = [];
  let root = null;
  for (const r of rows) {
    const keys = [1, 2].filter((n) => yes(r[`access_key_${n}_active`])).map((n) => ({ created: val(r[`access_key_${n}_last_rotated`]), last_used: val(r[`access_key_${n}_last_used_date`]), service: val(r[`access_key_${n}_last_used_service`]) }));
    const u = { name: r.user, arn: r.arn, created: val(r.user_creation_time), console: yes(r.password_enabled), password_last_used: val(r.password_last_used), mfa: yes(r.mfa_active), keys };
    if (r.user === "<root_account>") root = { mfa: u.mfa, keys: u.keys, password_last_used: u.password_last_used };
    else users.push(u);
  }
  for (const u of users) {
    const p = aws("iam", "list-attached-user-policies", "--user-name", u.name);
    const g = aws("iam", "list-groups-for-user", "--user-name", u.name);
    u.policies = (p?.AttachedPolicies || []).map((x) => x.PolicyName);
    u.groups = (g?.Groups || []).map((x) => x.GroupName);
  }
  const list = aws("iam", "list-roles", "--max-items", "1000");
  const roles = [];
  for (const r of list?.Roles || []) {
    const full = aws("iam", "get-role", "--role-name", r.RoleName)?.Role || r;
    const pol = aws("iam", "list-attached-role-policies", "--role-name", r.RoleName);
    const stmts = [].concat(r.AssumeRolePolicyDocument?.Statement || []);
    const trusted = [...new Set(stmts.flatMap((s) => { const p = s.Principal || {}; return [].concat(p.Service || [], p.AWS || [], p.Federated || []); }))];
    roles.push({ name: r.RoleName, path: r.Path, created: r.CreateDate, last_used: full.RoleLastUsed?.LastUsedDate || null, last_region: full.RoleLastUsed?.Region || null, trusted, service_linked: r.Path?.startsWith("/aws-service-role/") || false, policies: (pol?.AttachedPolicies || []).map((x) => x.PolicyName), description: (r.Description || "").slice(0, 200) });
  }
  return { account: who.Account, caller: who.Arn.replace(/:\d{12}:/, ":…:"), root, users, roles };
}

// ---------- Infisical: names only ----------
function infisical() {
  let project = opt("--infisical-project");
  if (!project && existsSync(".infisical.json")) project = JSON.parse(readFileSync(".infisical.json", "utf8")).workspaceId;
  if (!project || !run("infisical", ["--version"])) return null;
  const envs = (opt("--envs", "prod,staging,dev")).split(",").filter(Boolean);
  const out = [];
  for (const env of envs) {
    const table = run("infisical", ["secrets", "folders", "get", `--env=${env}`, "--path=/", `--projectId=${project}`, "--silent"]);
    if (table == null) continue;
    const folders = ["/", ...[...table.matchAll(/│\s*([^│\s][^│]*?)\s*│\s*\/\s*│/g)].map((m) => "/" + m[1].trim()).filter((f) => f !== "/FOLDER NAME")];
    for (const path of folders) {
      const json = run("infisical", ["export", `--env=${env}`, `--path=${path}`, "--format=json", `--projectId=${project}`, "--silent"]);
      if (!json) continue;
      let names = [];
      try { names = JSON.parse(json).map((x) => String(x.key)); } catch { continue; }
      out.push({ env, path, keys: names.sort() });
    }
  }
  return { project, environments: envs, folders: out };
}

// ---------- send ----------
const payload = [];
const a = iam();
if (a) payload.push({ kind: "aws-iam", data: a });
const f = infisical();
if (f) payload.push({ kind: "infisical", data: f });
const body = JSON.stringify(payload);
// last guard: nothing that looks like a credential may leave
if (/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN|sk-or-v1-|sk-ant-|postgres(ql)?:\/\/[^"]*@|ghp_|gho_|ghs_|xox[bp]-/.test(body)) { console.error("security-inventory: refused, the payload looks like it contains a credential"); process.exit(1); }
if (DRY) { console.log(JSON.stringify(payload, null, 2)); process.exit(0); }
let url = process.env.LEVEL5_URL, key = process.env.LEVEL5_KEY;
if ((!url || !key) && existsSync(".claude/level5.json")) { const c = JSON.parse(readFileSync(".claude/level5.json", "utf8")); url ||= c.url; key ||= c.key; }
if (!url || !key) { console.error("security-inventory: set LEVEL5_URL and LEVEL5_KEY, or run in a repo with .claude/level5.json"); process.exit(1); }
const r = await fetch(`${url}/api/inventory`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body });
console.log(`security-inventory: ${r.status} ${await r.text()} (${a ? `${a.users.length} users, ${a.roles.length} roles` : "no AWS"}; ${f ? `${f.folders.reduce((n, x) => n + x.keys.length, 0)} secret names in ${f.folders.length} folders` : "no Infisical"})`);
