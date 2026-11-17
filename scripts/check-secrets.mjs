// Fails the build if a likely secret is committed to Git.
// WHY: once a secret is pushed, it must be considered leaked. Rotating it is painful, so catching it
// before merge is much cheaper. This is a small, dependency-free check. Dedicated scanners (gitleaks,
// GitHub secret scanning) are more thorough and should also be enabled on the repository.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: 'generic secret assignment',
    re: /\b(?:SECRET|PASSWORD|TOKEN_SECRET|CONSUMER_SECRET)\s*=\s*['"]?[A-Za-z0-9/+]{24,}/,
  },
];

// Files that are allowed to contain obvious placeholders.
const ALLOW = new Set(['.env.example', 'scripts/check-secrets.mjs']);

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const forbiddenFiles = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && f !== '.env.example');
const findings = forbiddenFiles.map((f) => `${f}: environment file must not be committed`);

for (const f of files) {
  if (ALLOW.has(f) || /\.(docx|png|jpg|ach)$/.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) if (re.test(text)) findings.push(`${f}: possible ${name}`);
}

if (findings.length) {
  console.error('Secret scan FAILED:\n' + findings.map((x) => `  - ${x}`).join('\n'));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} tracked files).`);
