/**
 * Dangerous shell command detection used by terminal backends and the approval flow.
 */

export interface CommandRisk {
  level: 'safe' | 'moderate' | 'dangerous';
  reasons: string[];
}

const DANGEROUS: Array<[string, RegExp]> = [
  ['recursive delete of root/home', /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME|\/\*|\.\.?)(\s|$)/],
  ['rm -rf', /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/],
  ['disk format/overwrite', /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b|\bdd\s+[^|]*of=\/dev\//],
  ['fork bomb', /:\(\)\s*\{\s*:\|:&\s*\};:/],
  ['system power', /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/],
  ['permission bomb', /\bchmod\s+(-R\s+)?777\s+\/|\bchown\s+-R\s+\S+\s+\/(\s|$)/],
  ['pipe remote script to shell', /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/],
  ['write to block device', />\s*\/dev\/(sd|nvme|hd)/],
  ['privilege escalation', /\bsudo\b|\bsu\s+-|\bdoas\b/],
  ['history/credential access', /\.ssh\/id_|\/etc\/shadow|\.aws\/credentials|\.env\b/],
  ['Mercury secrets/state access', /\bsecret\.key\b|\bmercury\.db\b|\.mercury\/|\$\{?MERCURY_HOME|MERCURY_JWT_SECRET/],
  ['process environment access', /\/proc\/[^\s/]+\/environ\b/],
  ['kill all processes', /\bkill(all)?\s+-9\s+(-1|1)\b|\bpkill\s+-9\s+\./],
  ['git destructive', /\bgit\s+(push\s+.*--force|reset\s+--hard|clean\s+-[a-z]*f)/],
];

const MODERATE: Array<[string, RegExp]> = [
  ['package install', /\b(npm|pnpm|yarn|pip3?|apt(-get)?|brew|cargo|go)\s+(i|install|add)\b/],
  ['network access', /\b(curl|wget|nc|ncat|ssh|scp|rsync)\b/],
  ['file deletion', /\brm\b|\bunlink\b|\brmdir\b/],
  ['process control', /\bkill\b|\bpkill\b/],
  ['docker', /\bdocker\b/],
  ['inline interpreter code (bypasses command checks)', /\b(python[0-9.]*|node|perl|ruby|php)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[ecr]\b|\bnode\s+--(eval|print)\b|\b(ba|z|da)?sh\s+-[a-zA-Z]*c\b|\beval\b/],
  ['decoded payload execution', /\bbase64\s+(-d|--decode)\b|\bxxd\s+-r\b/],
  ['environment dump', /(^|[;&|]\s*)(env|printenv|export\s+-p|set)\s*($|[;&|>])/],
  ['find with -delete/-exec', /\bfind\b[^|;]*\s-(delete|exec|execdir)\b/],
];

export function assessCommand(command: string): CommandRisk {
  const reasons: string[] = [];
  for (const [why, re] of DANGEROUS) if (re.test(command)) reasons.push(why);
  if (reasons.length) return { level: 'dangerous', reasons };
  for (const [why, re] of MODERATE) if (re.test(command)) reasons.push(why);
  return { level: reasons.length ? 'moderate' : 'safe', reasons };
}
