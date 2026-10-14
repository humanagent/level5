// The installer, with the kit /typev-setup works from: its own skill goes in live under
// .claude/skills/, the templates it copies wait under .claude/typev/templates/. Everything the
// kit writes is a new file named typev, so a reinstall only ever replaces Type V's own files.
import { readFileSync, readdirSync } from "node:fs";

const KIT = new URL("./kit/", import.meta.url);
const walk = (base = "") => readdirSync(new URL(base, KIT), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(base + e.name + "/") : [base + e.name]));

export function installer() {
  const files = walk().sort().map((f) => {
    const to = f.startsWith("skills/") ? ".claude/" + f : ".claude/typev/" + f;
    const body = readFileSync(new URL(f, KIT), "utf8").replace(/\n?$/, "\n");
    if (body.includes("\nTYPEVKIT\n")) throw new Error(`kit file ${f} contains the heredoc marker`);
    return `mkdir -p "${to.slice(0, to.lastIndexOf("/"))}"\ncat > "${to}" <<'TYPEVKIT'\n${body}TYPEVKIT\n`;
  });
  return readFileSync(new URL("./install.sh", import.meta.url), "utf8").replace("# __KIT__\n", () => files.join("\n")); // a function: the kit has `$'` in it
}
